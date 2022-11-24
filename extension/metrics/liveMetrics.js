/*    Copyright 2021 Firewalla INC
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

const rclient = require('../../util/redis_manager.js').getRedisClient();
const log = require('../../net2/logger.js')(__filename);

const NetworkProfileManager = require('../../net2/NetworkProfileManager');
const SysInfo = require('../sysinfo/SysInfo.js');

const HostManager = require('../../net2/HostManager.js');
const hostManager = new HostManager();

const PolicyManager2 = require('../../alarm/PolicyManager2.js');
const pm2 = new PolicyManager2();

const AlarmManager2 = require('../../alarm/AlarmManager2.js');
const alarmManager2 = new AlarmManager2();

const HostManager = require('../../net2/HostManager.js');
const hostManager = new HostManager();

const sysManager = require('../../net2/SysManager.js');

let instance = null;

class LiveModeMetrics {
  constructor() {
    if (instance === null) {
      instance = this;
    }
    return instance;
  }

  async collectMetrics() {
    const begin = Date.now() / 1000;

    const metrics = {};
    const extensionManager = require('../../sensor/ExtensionManager');

    // number of rules
    const policyRules = await pm2.loadActivePoliciesAsync({ includingDisabled: 1 });
    metrics.rules = policyRules.filter(p => p.action == "block" || p.action == "block").length;

    // number of alarms
    metrics.alarms = await alarmManager2.getActiveAlarmCount();

    // number of devices
    const json = {};
    await Promise.all([hostManager.identitiesForInit(json), hostManager.hostsInfoForInit(json)]);
    let count = json.hosts.length;
    if (json.wgPeers) count += json.wgPeers.length
    metrics.devices = count;

    // public IP
    metrics.publicIp = sysManager.publicIp;

    // wan throughput
    const intfStats = (await extensionManager.get("liveStats", null, {
      type: "system"
    })).throughput;
    const activeWans = NetworkProfileManager.getActiveWans().map(intf => intf.uuid);
    const wanStats = intfStats.filter(x => activeWans.includes(x.target))
    let rx = 0, tx = 0;
    wanStats.forEach(w => { rx += w.rx; tx += w.tx });
    metrics.throughput = {
      rx, tx
    }

    // data usage
    metrics.dataUsage = await extensionManager.get("monthlyUsageStats");

    const sysInfo = SysInfo.getSysInfo();

    // disk usage
    metrics.diskUsage = sysInfo.diskInfo.map(d => {
      return { total: d.size, used: d.used, mount: d.mount }
    })

    // os uptime
    metrics.osUptime = sysInfo.osUptime;

    // load
    metrics.load = {
      load1: sysInfo.load1,
      load5: sysInfo.load5,
      load15: sysInfo.load15
    }

    // memory usage
    metrics.memUsage = {
      total: sysInfo.allMem,
      used: sysInfo.usedMem
    }

    // flows 
    const flowStats = await hostManager.getStats({ granularities: '1hour', hits: 24 }, "0.0.0.0", ['conn', 'ipB', 'dns', 'dnsB']);
    metrics.flows = {
      total: flowStats.totalConn + flowStats.totalDns + flowStats.totalDnsB + flowStats.totalIpB,
      blocked: flowStats.totalDnsB + flowStats.totalIpB
    }
    log.info("Collect live mode metrics cost ", (Date.now() / 1000 - begin).toFixed(2));
    return metrics;
  }
}

module.exports = new LiveModeMetrics();