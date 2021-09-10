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
const featureName = 'fastflow'
const Promise = require('bluebird');
const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);

class FlowCompressionSensor extends Sensor {
  constructor() {
    super();
  }

  async loadFlows() {
    let completed = false
    const options = {
      begin: new Date() / 1000 - 24 * 3600, // 24 hours before
      audit: true,
      count: 2000,
      asc: true
    }
    let allFlows = []
    const begin = new Date() / 1000
    while (!completed) {
      console.log(`processing get flows now:${new Date()} begin time:${new Date(options.begin * 1000)}`)
      const flows = await flowTool.prepareRecentFlows({}, JSON.parse(JSON.stringify(options))) || []
      console.log(`got flows length ${flows.length}`)
      console.log(`fisrt one${new Date(flows[0].ts * 1000)}, last one ${new Date(flows[flows.length - 1].ts * 1000)}`)
      if (flows.length < options.count) {
        completed = true
      } else {
        options.begin = flows[flows.length - 1].ts
      }
      allFlows = allFlows.concat(flows)
    }
    log.info(`get ${allFlows.length} flows cost ${(new Date() / 1000 - begin).toFixed(2)} seconds`)
    var total = 0;
    allFlows.map(flow => {
      total = total + flow.count
    })
    log.info("jack test lalalal", total)
    this.compress(allFlows)
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
    log.info(`Compress ${mergedFlows.length} flows, 
    raw: ${Buffer.byteLength(str)} deflate: ${Buffer.byteLength(deflateBuffer)} ${deflateBuffer.length} 
    base64:${Buffer.byteLength(base64Str)} ${deflateBuffer.toString('base64').length}`)
  }
}

new FlowCompressionSensor().loadFlows()

module.exports = FlowCompressionSensor;