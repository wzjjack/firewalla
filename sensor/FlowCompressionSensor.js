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
const auditTool = require('../net2/AuditTool');
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
const deflateAsync = Promise.promisify(zlib.deflate);
const sem = require('./SensorEventManager.js').getInstance();
const { Duplex, Readable } = require('stream');
const EventEmitter = require('events');
const MAX_MEM = 10 * 1000 * 1000;
const delay = require('../util/util.js').delay;
const uuid = require('uuid');
const Queue = require('bee-queue')

class FlowCompressionSensor extends Sensor {
  constructor() {
    super()
    this.lastestTsKey = "compressed:flows:lastest:ts"
    this.step = this.config.step || 30 * 60 // half an hour
    this.maxInterval = this.config.maxInterval || 24 * 60 * 60 // 24 hours
    this.maxBufferSize = 10000
  }

  async run() {
    this.hookFeature(featureName);
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
    this.jobCnt = 0;
    this.queue.process(async (job, done) => {
      log.info("process flow stream job");
      try {
        if (job && job.data) { // raw flow string
          const data = JSON.parse(job.data);
          const flow = await this.raw2Flow(data);
          while (!this.readableStream || this.readableStream.destroyed) {
            log.info("deferred due to readableStream might be destoryed and re-create");
            await delay(3 * 1000)
          }
          this.readableStream.push(JSON.stringify(flow))
          this.jobCnt++;
          if (this.jobCnt >= 50) { // save the result to the redis
            await this.dumpStreamFlows();
            this.jobCnt = 0;
          }
        }
      } catch (e) {
        log.info("process job error", e);
      } finally {
        done();
      }
    })
  }

  setupStream() {
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

  async globalOn() {
    const now = new Date() / 1000;
    this.setupFlowsQueue();
    this.setupStream();
    sclient.on("message", async (channel, message) => {
      if (channel === "Flow2Stream") {
        if (this.queue) {
          const job = this.queue.createJob(message);
          job.timeout(3000).retries(2).save((err) => {
            if (err) {
              log.error("Failed to create flows stream job", err.message);
            }
          })
        }
      }
    });
    sclient.subscribe("Flow2Stream")
    await this.build(now)
  }

  async globalOff() {
    sclient.unsubscribe("Flow2Stream");
    this.queue && this.queue.destroy();
    this.destroyStreams();
  }

  async dumpStreamFlows() {
    if (this.readableStream) {
      this.readableStream.push(null); // stop readable stream
      const result = await this.streamToString(); // dump the result to the redis
      const now = new Date() / 1000;
      log.info("jack test dumpStreamFlows", result, now)
      await this.save(now, result);
      this.destroyStreams();
      await this.setupStream(); // re-create streams
      return result;
    }
    return null;
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

  async apiRun() {
    extensionManager.onGet("compressedLastestTs", async (msg, data) => {
      const recentlyTickTs = Number(await rclient.getAsync(this.lastestTsKey) || 0)
      return { ts: recentlyTickTs }
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
    let { begin, end } = options
    const compressedFlowsKeys = await this.getCompreesedFlowsKey()
    const compressedFlows = []
    for (const key of compressedFlowsKeys) {
      const ts = key.split(":")[2];
      if (ts < begin) continue
      const str = await rclient.getAsync(key)
      str && compressedFlows.push(str)
    }
    const extraFlows = await this.dumpStreamFlows();
    extraFlows && compressedFlows.push(extraFlows);
    return compressedFlows
  }

  getKey(ts) {
    return `compressed:flows:${ts}`
  }

  async build(now) {
    try {
      let begin = Number(await rclient.getAsync(this.lastestTsKey) || 0)
      if (now - begin > this.maxInterval) {
        begin = now - this.maxInterval
      }
      log.info(`Going to compress flows between ${new Date(begin * 1000)} - ${new Date(now * 1000)}`)
      let completed = false
      const options = {
        begin: begin,
        end: now,
        audit: true,
        count: 2000,
        asc: true
      }
      let buffer = []
      let processFlowsCnt = 0
      let processLogsCnt = 0
      while (!completed) {
        try {
          const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
          if (flows.length < options.count) {
            completed = true
          } else {
            options.begin = flows[flows.length - 1].ts
          }
          processFlowsCnt += flows.length
          for (const flow of flows) {
            processLogsCnt += flow.count || 0
            buffer.push(flow)
            if (buffer.length >= this.maxBufferSize) {
              await this.save(buffer[buffer.length - 1].ts, await this.compress(buffer))
              await this.checkAndCleanMem()
              buffer = []
            }
          }
        } catch (e) {
          log.error(`Load flows error`, e)
          completed = true
        }
      }
      if (buffer.length > 0) {
        await this.save(buffer[buffer.length - 1].ts, await this.compress(buffer))
        await this.checkAndCleanMem()
      }
      log.info(`Compressed ${processFlowsCnt} flows, ${processLogsCnt} logs build completed, cost ${(new Date() / 1000 - now).toFixed(2)}`)
    } catch (e) {
      log.error(`Compress flows error`, e)
    }
  }

  async save(ts, base64Str) {
    const key = this.getKey(ts)
    await rclient.setAsync(key, base64Str)
    await rclient.expireatAsync(key, Math.ceil(ts + this.maxInterval))
    await rclient.setAsync(this.lastestTsKey, ts)
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
    return base64Str
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
