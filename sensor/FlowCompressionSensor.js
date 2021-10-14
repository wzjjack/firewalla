/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const flowTool = require('../net2/FlowTool');
const log = require('../net2/logger.js')(__filename)
const _ = require('lodash');
const Sensor = require('./Sensor.js').Sensor
const fc = require('../net2/config.js');
const featureName = 'compress_flows'
const Promise = require('bluebird');
const zlib = require('zlib');
const extensionManager = require('./ExtensionManager.js')
const rclient = require('../util/redis_manager').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()
const deflateAsync = Promise.promisify(zlib.deflate);
const sem = require('./SensorEventManager.js').getInstance();
const MAX_MEM = 10 * 1000 * 1000
const delay = require('../util/util.js').delay;
const Queue = require('bee-queue');
const { Readable } = require('stream');
const SPLIT_STRING = "\n\n";
const CronJob = require('cron').CronJob;
const uuid = require('uuid');

class FlowCompressionSensor extends Sensor {
  constructor() {
    super()
    this.lastestTsKey = "compressed:flows:lastest:ts"
    this.step = 60 * 60 // one hour
    this.maxInterval = 24 * 60 * 60 // 24 hours
  }

  async run() {
    this.hookFeature(featureName);
    sem.on('Flow2Stream', (event) => {
      if (this.queue) {
        const { raw, audit } = event;
        const job = this.queue.createJob({ raw, audit });
        job.timeout(3000).retries(2).save((err) => {
          if (err) {
            log.error("Failed to create flows stream job", err.message);
          }
        })
      }
    })

    sem.on('DumpStreamFlows', async (event) => {
      const id = event.messageId;
      log.info("jack test got DumpStreamFlows event", id)
      const now = new Date() / 1000;
      const nowTickTs = now - now % this.step + this.step;
      await this.dumpStreamFlows(nowTickTs);
      log.info("jack test publish event", `DumpStreamFlows:Done-${id}`)
      sem.emitEvent({
        type: `DumpStreamFlows:Done-${id}`,
        toProcess: "FireApi",
        suppressEventLogging: false,
        message: "DumpStreamFlows:Done"
      })
    })

  }

  setupFlowsQueue() {
    this.queue = new Queue(`flows-stream`, {
      removeOnFailure: true,
      removeOnSuccess: true
    })
    this.queue.on('error', (err) => {
      log.error("Queue got err:", err)
    })
    this.queue.on('failed', (job, err) => {
      log.error(`Job ${job.id} ${job.action} failed with error ${err.message}`);
    });
    this.queue.destroy(() => {
      log.info("flows stream queue is cleaned up")
    })
    this.queue.process(async (job, done) => {
      try {
        if (job && job.data) { // raw flow string
          const flow = await this.raw2Flow(job.data);
          while (this.dumping) {
            log.info("deferred due to readableStream might be destoryed and re-create");
            await delay(1000)
          }
          this.readableStream.push(JSON.stringify(flow) + SPLIT_STRING)
        }
      } catch (e) {
        log.info("process job error", e);
      } finally {
        done();
      }
    })
  }

  setupStreams() {
    const readableStream = new Readable({
      read() { }
    })
    const def = zlib.createDeflate();
    const zstream = readableStream.pipe(def);
    const chunks = [];
    this.readableStream = readableStream;
    this.streamToString = () => {
      return new Promise((resolve, reject) => {
        zstream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        zstream.on('error', (err) => reject(err));
        zstream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      })
    }
    this.destroyStreams = () => {
      readableStream.destroy();
      def.destroy();
      zstream.destroy();
    }
  }

  async dumpStreamFlows(ts) {
    while (this.dumping) {
      await delay(1000)
    }
    this.dumping = true;
    try {
      if (this.readableStream) {
        this.readableStream.push(null); // readable stream EOF
        const result = await this.streamToString(); // dump the result to the redis
        log.info("jack test dumpStreamFlows", result, new Date(ts * 1000))
        await this.save(ts, result);
        this.destroyStreams(); // destory and re-create
        await this.setupStreams();
      }
    } catch (e) {
      log.info("jack test dumpStreamFlows error", e)
    }
    this.dumping = false
  }

  async raw2Flow(message) {
    const { raw, audit } = message;
    if (audit) {

    } else {
      const flow = flowTool.toSimpleFormat(raw)
      const enriched = await flowTool.enrichWithIntel([flow])
      return enriched[0]
    }
  }


  async globalOn() {
    const now = new Date() / 1000;
    this.setupFlowsQueue();
    this.setupStreams();
    this.cornJob && this.cornJob.stop();
    this.cornJob = new CronJob("0 0 * * * *", async () => {
      log.info("jack test corn job trigger");
      // dump flow stream to redis every hour
      const now = new Date() / 1000;
      const nowTickTs = now - now % this.step;
      await this.dumpStreamFlows(nowTickTs);
    }, null, true)
    await this.build(now);
  }

  async globalOff() {
    this.queue && this.queue.destroy();
    this.queue = null;
    this.destroyStreams();
    this.cornJob && this.cornJob.stop();
    this.cornJob = null;
  }

  async checkAndCleanMem() {
    const compressedFlowsKeys = await this.getCompreesedFlowsKey()
    let compressedMem = 0
    let delFlag = false
    for (const key of compressedFlowsKeys) {
      if (delFlag) { // delete all earlier keys
        await rclient.delAsync(key);
        continue;
      }
      const mem = Number(await rclient.memoryAsync("usage", key) || 0)
      compressedMem += mem
      if (compressedMem > MAX_MEM) { // accumulate memory size from the latest
        delFlag = true;
        await rclient.delAsync(key);
      }
    }
  }

  async apiRun() {
    extensionManager.onGet("compressedLastestTs", async (msg, data) => {
      const lastestTs = Number(await rclient.getAsync(this.lastestTsKey) || 0)
      return { ts: lastestTs }
    })

    extensionManager.onGet("compressedflows", async (msg, data) => {
      const result = {}
      const now = new Date() / 1000
      result["compressedflows"] = await this.loadCompressedFlows(data)
      log.info(`Get flows cost ${(new Date() / 1000 - now).toFixed(2)}`)
      return result
    });
  }

  async loadCompressedFlows(options) {
    // options {begin,end}
    let { begin, end } = options
    log.info(`Load compressed flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    begin = begin - begin % this.step
    end = end - end % this.step + this.step
    await this.waitRealtimeDumpDone();
    const compressedFlows = []
    for (let i = 0; i < (end - begin) / this.step; i++) {
      const endTs = begin + this.step * (i + 1)
      const str = await rclient.getAsync(this.getKey(endTs))
      str && compressedFlows.push(str)
    }
    return compressedFlows
  }

  async waitRealtimeDumpDone() {
    const messageId = uuid.v4();
    sem.emitEvent({
      type: "DumpStreamFlows",
      toProcess: 'FireMain',
      suppressEventLogging: false,
      messageId: messageId
    })
    return new Promise((resolve) => {
      const channelId = `DumpStreamFlows:Done-${messageId}`
      log.info("jack test subscribe event", channelId)
      sem.on(channelId, (event) => {
        log.info("jack test DumpStreamFlows:Done", event)
        resolve()
      })
      setTimeout(() => {
        resolve();
      }, 30 * 1000);
    })
  }

  getKey(ts) {
    return `compressed:flows:${ts}`
  }

  async build(now) {
    while (this.building) {
      await delay(30 * 1000)
    }
    this.building = true;
    try {
      const { begin, end } = await this.getBuildingWindow(now);
      if (begin == end) return
      log.info(`Going to compress flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
      for (let i = 0; i < (end - begin) / this.step; i++) {
        const beginTs = begin + this.step * i
        const endTs = begin + this.step * (i + 1)
        const flows = await this.loadFlows(beginTs, endTs)
        await this.save(endTs, await this.compress(flows))
      }
      await this.checkAndCleanMem()
      log.info(`Compressed flows build complted, cost ${(new Date() / 1000 - now).toFixed(2)}`)
    } catch (e) {
      log.error(`Compress flows error`, e)
    }
    this.building = false;
  }

  async save(ts, base64Str) {
    const key = this.getKey(ts)
    if (await rclient.existsAsync(key)) {
      log.info("jack test the key is exist, then append the str", key)
      const existsVal = await rclient.getAsync(key);
      base64Str = existsVal + SPLIT_STRING + base64Str;
    }
    await rclient.setAsync(key, base64Str)
    await rclient.expireatAsync(key, Math.ceil(ts + this.maxInterval))
    await rclient.setAsync(this.lastestTsKey, ts)
  }

  async getBuildingWindow(now) {
    const nowTickTs = now - now % this.step + this.step;
    let lastestTs = Number(await rclient.getAsync(this.lastestTsKey) || 0)
    if (nowTickTs - lastestTs > this.maxInterval) {
      lastestTs = nowTickTs - this.maxInterval
    }
    return {
      begin: lastestTs,
      end: nowTickTs
    }
  }

  async loadFlows(begin, end) {
    log.info(`Going to load flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    let completed = false
    const options = {
      begin: begin,
      end: end,
      audit: true,
      count: 2000,
      asc: true
    }
    let allFlows = []
    const now = new Date() / 1000
    while (!completed) {
      try {
        const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
        if (flows.length < options.count) {
          completed = true
        } else {
          options.begin = flows[flows.length - 1].ts
        }
        allFlows = allFlows.concat(flows)
      } catch (e) {
        log.error(`Load flows error`, e)
        completed = true
      }
    }
    log.debug(`get ${allFlows.length} flows cost ${(new Date() / 1000 - now).toFixed(2)} seconds`)
    // debug purpose
    log.debug(`there are ${allFlows.reduce((ac, val) => ac + val.count, 0)} zeek logs for these flows`)
    return allFlows
  }

  mergeFlows(flows) {
    if (!flows || flows.length == 0) return [];
    let stash = flows[0];
    const mergedFlows = [stash];
    const compareKeys = ["ltype", "fd", "device", "protocol", "host", "ip", "domain"]
    for (var i = 1; i < flows.length; i++) {
      const flow = flows[i]
      if (_.isEqual(_.pick(stash, compareKeys), _.pick(flow, compareKeys))) {
        stash.count += flow.count
        stash.download += flow.download
        stash.upload += flow.upload
        stash.duration += flow.duration
      } else {
        stash = flow
        mergedFlows.push(stash)
      }
    }
    return mergedFlows
  }
  async compress(flows) {
    const mergedFlows = this.mergeFlows(flows)
    const str = JSON.stringify(mergedFlows)
    const deflateBuffer = await deflateAsync(str)
    const base64Str = deflateBuffer.toString('base64')
    log.debug(`Compress ${mergedFlows.length} flows, raw: ${str.length} deflate: ${deflateBuffer.length} base64:${base64Str.length}`)
    return base64Str
  }

  async getCompreesedFlowsKey() {
    const compressedFlowsKeys = await rclient.scanResults(this.getKey("*"), 1000) || []
    return compressedFlowsKeys.filter(key => key != this.lastestTsKey).sort((a, b) => {
      const ts1 = a.split(":")[2];
      const ts2 = b.split(":")[2];
      return ts1 > ts2 ? -1 : 1
    })
  }

}


module.exports = FlowCompressionSensor;