/*    Copyright 2020 Firewalla Inc.
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


'use strict'

const log = require('../../net2/logger.js')(__filename)
const fc = require('../../net2/config.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const Message = require('../../net2/Message.js');
const tracking = require('./tracking.js');
const accounting = require('./accounting.js');
let instance = null;
const runningCheckJobs = {};
const INTF_PREFIX = "intf:";
const TAG_PREFIX = "tag:";
const MAC_PREFIX = "mac:"
const _ = require('lodash');

/*
action: screentime
target: av | customize category name | wechat | default: internet
type: app | category | mac
threshold: 120(mins)
resetTime: 2*60*60 seconds => 02:00 - next day 02:00, default: 0
scope: ['mac:xx:xx:xx:xx','tag:uid','intf:uuid']
*/

class ScreenTime {
    constructor() {
        if (instance == null) {
            instance = this;
        }
        sclient.on("message", async (channel, message) => {
            if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
                log.info(`System timezone is reloaded, schedule reload scheduled policies ...`);
                this.scheduleReload();
            }
        });
        sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
        return instance;
    }

    scheduleReload() {
        if (this.reloadTask)
            clearTimeout(this.reloadTask);
        this.reloadTask = setTimeout(async () => {
            const policyCopy = Object.keys(runningCheckJobs).map(pid => runningCheckJobs[pid].policy);
            for (const policy of policyCopy) {
                if (policy) {
                    await this.deregisterPolicy(policy);
                    await this.registerPolicy(policy);
                }
            }
        }, 5000);
    }
    async registerPolicy(policy) {
        const pid = policy.pid
        if (runningCheckJobs[pid]) { // already have a running job for this pid
            return;
        }
        log.info(`Registering policy ${policy.pid} for screentime check`)
        const timer = setInterval(() => {
            this.checkAndRunOnce(policy);
        }, 5 * 60 * 1000) // check every 5 mins
        runningCheckJobs[pid] = { policy, timer }; // register job
        this.checkAndRunOnce(policy);
    }

    async deregisterPolicy(policy) {
        const pid = policy.pid
        if (pid == undefined) {
            return;
        }
        log.info(`deregistering policy ${pid}`)
        const timer = runningCheckJobs[pid] && runningCheckJobs[pid].timer;
        timer && clearInterval(timer);
        delete runningCheckJobs[pid]
    }
    dependFeatureEnabled() {
        if (!platform.isAccountingSupported() || !fc.isFeatureOn("accounting")) {
            log.info("Accounting feature is not supported or disabled.");
            return false;
        }
        return true;
    }
    async checkAndRunOnce(policy) {
        if (!this.dependFeatureEnabled()) return;
        const runningCheckJob = runningCheckJobs[policy.pid];
        if (!runningCheckJob) {
            log.warn(`screen time check job ${policy.pid} doesn't register`);
            return;
        }
        const timeFrame = this.generateTimeFrame(policy);
        if (runningCheckJob.limited && runningCheckJob.endOfResetTime == timeFrame.endOfResetTime) {
            log.info(`screen time limted alredy reached, pids:${runningCheckJob.pids.join(',')} aid: ${runningCheckJob.aid}`);
            return;
        }
        const macs = this.getPolicyRelatedMacs(policy);
        const count = await this.getMacsUsedTime(macs, policy, timeFrame);
        log.info(`check policy ${policy.pid} screen time: ${count}, macs: ${macs}`, policy);
        const { threshold } = policy;
        if (Number(count) > Number(threshold)) {
            const pids = await this.createRule(policy, timeFrame);
            if (pids.length == 0) return;
            const aid = await this.createAlarm(policy, {
                pids: pids,
                timeFrame: timeFrame
            });
            runningCheckJob.limited = true;
            runningCheckJob.aid = aid;
            runningCheckJob.pids = pids;
            runningCheckJob.endOfResetTime = timeFrame.endOfResetTime;
        } else {
            runningCheckJob.limited = false;
        }
    }
    async createRule(policy, timeFrame) {
        const PM2 = require('../../alarm/PolicyManager2.js');
        const pm2 = new PM2();
        const policyPayloads = this.generatePolicyPayloads(policy, timeFrame);
        try {
            const result = await pm2.batchPolicy({
                "create": policyPayloads
            })
            const pids = (result.create || []).filter(rule => rule && rule.pid).map(rule => rule.pid);
            pids.length > 0 && log.info("Auto pause policy is created successfully, pids:", pids);
            return pids
        } catch (err) {
            log.error("Failed to create policy:", err);
        }
    }
    async createAlarm(policy, info) {
        const { timeFrame, pids } = info;
        const Alarm = require('../../alarm/Alarm.js');
        const AM2 = require('../../alarm/AlarmManager2.js');
        const am2 = new AM2();
        log.info(`screen time policy ${policy.pid} trigger time limit ${policy.threshold}, beginOfResetTime:${timeFrame.beginOfResetTime},endOfResetTime:${timeFrame.endOfResetTime}`);
        const alarm = new Alarm.ScreenTimeAlarm(new Date() / 1000,
            'screetime',
            {
                "p.pid": policy.pid,
                "p.scope": policy.scope,
                "p.threshold": policy.threshold,
                "p.resettime.begin": timeFrame.beginOfResetTime,
                "p.resettime.end": timeFrame.endOfResetTime,
                "p.auto.pause.pids": pids,
                "p.target": policy.target,
                "p.type": policy.type
            });
        am2.enqueueAlarm(alarm);
    }
    generatePolicyPayloads(policy, timeFrame) {
        const basePayload = { //policyPayload same as payload with app policy:create
            action: 'block',
            target: 'TAG',
            expire: timeFrame.expire,
            activatedTime: timeFrame.now / 1000,
            cronTime: '',
            duration: '',
            tag: [],
            scope: [],
            type: 'mac',
            direction: "bidirection",
            disabled: '0',
            dnsmasq_only: false,
            autoDeleteWhenExpires: '1',
            related_screen_time_pid: policy.pid
        }
        const policyPayloads = [];
        const { scope, type, target } = policy;
        const blockInternet = !['app', 'category'].includes(type);
        if (!blockInternet) {
            basePayload.target = target;
            basePayload.type = type;
        }
        if (scope && scope.length > 0) {
            for (const ele of scope) {
                const policyPayloadCopy = JSON.parse(JSON.stringify(basePayload));
                if (ele.includes(MAC_PREFIX)) {
                    const mac = ele.split(MAC_PREFIX)[1];
                    blockInternet && (policyPayloadCopy.target = mac);
                    !blockInternet && (policyPayloadCopy.scope = [mac]);
                } else if (ele.includes(INTF_PREFIX) || ele.includes(TAG_PREFIX)) {
                    policyPayloadCopy.tag = [ele];
                }
                policyPayloads.push(policyPayloadCopy);
            }
        } else { // global level
            policyPayloads.push(basePayload);
        }
        return policyPayloads;
    }
    generateTimeFrame(policy) {
        const resetTime = policy.resetTime || 0;
        // calculate expire by resetTime(02:00 - next day 02:00) resetTime should be 2*60*60 seconds
        // default time frame 00:00 - next day 00:00 default resetTime 0
        const now = new Date();
        const offset = now.getTimezoneOffset(); // in mins
        const timeWithTimezoneOffset = now - offset * 60 * 1000;
        const beginOfDate = Math.floor(timeWithTimezoneOffset / 1000 / 3600 / 24) * 3600 * 24 * 1000;
        const beginOfDateWithTimezoneOffset = beginOfDate + offset * 60 * 1000;
        const beginOfResetTime = beginOfDateWithTimezoneOffset + resetTime * 1000;
        const timeWindow = 24 * 60 * 60; // TBD it can be config, default 24hours
        const endOfResetTime = beginOfResetTime + timeWindow * 1000;
        const expire = endOfResetTime / 1000 - now / 1000;
        return {
            beginOfResetTime, endOfResetTime, expire, now
        }
    }
    getPolicyRelatedMacs(policy) {
        const HostManager = require("../../net2/HostManager.js");
        const hostManager = new HostManager();
        const { scope } = policy;
        if (!scope) return hostManager.getActiveMACs();
        let allMacs = [];
        for (const ele of scope) {
            if (ele.includes(MAC_PREFIX)) {
                allMacs.push(ele.split(MAC_PREFIX)[1]);
            } else if (ele.includes(INTF_PREFIX)) {
                const uuid = ele.split(INTF_PREFIX)[1];
                allMacs = allMacs.concat(hostManager.getIntfMacs(uuid));
            } else if (ele.includes(TAG_PREFIX)) {
                const tagUid = ele.split(TAG_PREFIX)[1];
                allMacs = allMacs.concat(hostManager.getTagMacs(tagUid));
            } else {
                allMacs = hostManager.getActiveMACs();
            }
        }
        return _.uniq(allMacs);
    }
    // TBD: get app/category used time
    async getMacsUsedTime(macs, policy, timeFrame) {
        if (!macs || macs.length == 0) return 0;
        const { target, type } = policy;
        const blockInternet = !['app', 'category'].includes(type);
        let count = 0;
        for (const mac of macs) {
            try {
                if (blockInternet) {
                    count += await tracking.getUsedTime(mac);
                } else {
                    count += await accounting.count(mac, target, timeFrame.beginOfResetTime, timeFrame.endOfResetTime);
                }
            } catch (e) { }
        }
        return count;
    }
}

module.exports = new ScreenTime();

