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
const { Duplex } = require('stream');
const EventEmitter = require('events');
const MAX_MEM = 10 * 1000 * 1000;
const delay = require('../util/util.js').delay;
const uuid = require('uuid');

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

  async globalOn() {
    const now = new Date() / 1000
    await this.setupStream()
    await this.build(now)
  }

  async setupStream() {
    this.em = new EventEmitter();
    this.compressedFlowsFromStream = "";
    this.inoutStream = new Duplex()
    this.inoutStream._read = (size) => {
      log.info("jack test read size", size)
    }
    this.inoutStream.on('readable', () => {
      log.info("jack test readable readable")
    })

    // override write
    this.inoutStream.write = (chunk, encoding, next) => {
      this.compressedFlowsFromStream += chunk.toString('base64');
      if (this.em && this.streamEventId) {
        this.em.emit(this.streamEventId, this.compressedFlowsFromStream)
        this.streamEventId = null;
      }
      next();
    }
    this.def = zlib.createDeflate();
    this.inoutStream.pipe(this.def).pipe(this.inoutStream)
    let flowsCnt = 0;
    sclient.on("message", async (channel, message) => {
      if (channel === "Flow2Stream") {
        message = JSON.parse(message);
        const flow = await this.raw2Flow(message);
        this.inoutStream.push(JSON.stringify(flow));
        // if (flowsCnt > this.maxBufferSize) {
        //   this.inoutStream.pause();
        //   const compressedStr = await this.getCompressedFlowsFromStream();
        //   await this.save(flow.ts, compressedStr);
        //   this.inoutStream.resume();
        //   flowsCnt = 0;
        // }
        log.info("jack test Flow2Stream come out")
      }
    });
    log.info("jack test subscribe Flows2Stream")
    sclient.subscribe("Flow2Stream")
  }

  async getCompressedFlowsFromStream() {
    /* 
      Calling .flush() on a compression stream will make zlib return as much output as currently possible. 
      This may come at the cost of degraded compression quality, 
      but can be useful when data needs to be available as soon as possible.
    */
    this.def.flush()
    while (this.streamEventId) {
      await delay(3000); // make sure last event done
      this.streamEventId = uuid.v4()
    }
    const result = await new Promise((resolve, reject) => {
      let handled = false;
      const callback = (data) => {
        log.info("jack test get result from write")
        if (!handled) {
          handled = true;
          resolve(data);
        }
      }
      setTimeout(() => {
        if (!handled) {
          handled = true;
          log.info("timeout")
          this.em.removeListener(this.id, callback);
          resolve(null);
        }
      }, 30 * 1000);
      this.em.once(this.streamEventId, callback)
    })
    return result
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

  async destoryStream() {
    sclient.unsubscribe("FlowsStream")
    this.inoutStream && this.inoutStream.destroy();
    this.em = null;
    this.compressedFlowsFromStream = "";
    this.streamEventId = null;
  }

  async globalOff() {
    if (this.timer) clearInterval(this.timer);
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
    // options {begin,end}
    let { begin, end } = options
    begin = begin - begin % this.step
    end = end - end % this.step
    if (begin == end) return []
    log.info(`Load compressed flows between ${new Date(begin * 1000)} - ${new Date(end * 1000)}`)
    const compressedFlows = []
    for (let i = 0; i < (end - begin) / this.step; i++) {
      const beginTs = begin + this.step * i
      const endTs = begin + this.step * (i + 1)
      const str = await rclient.getAsync(this.getKey(beginTs, endTs))
      str && compressedFlows.push(str)
    }
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
    log.info(`Compress ${mergedFlows.length} flows, raw: ${str.length} deflate: ${deflateBuffer.length} base64:${base64Str.length}`)
    return base64Str
  }

  async checkAndCleanMem() {
    let compressedFlowsKeys = await this.getCompreesedFlowsKey()
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
