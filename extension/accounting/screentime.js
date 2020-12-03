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
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const Message = require('../../net2/Message.js');
const tracking = require('./tracking.js');
let instance = null;
const runningCheckJobs = {};
const INTF_PREFIX = "intf:";
const TAG_PREFIX = "tag:";
const MAC_PREFIX = "mac:"
const HostManager = require("../../net2/HostManager.js");
const hostManager = new HostManager();

/*
target: av | customize category name | wechat
type: internet(default) | app | category
threshold: 120(mins)
resetTime: 2*60*60 seconds => 02:00 - next day 02:00, default 0
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
        if (!this.dependFeatureEnabled()) return;
        const pid = policy.pid
        if (runningCheckJobs[pid]) { // already have a running job for this pid
            return;
        }
        log.info(`Registering policy ${policy.pid} for screentime check`)
        const timer = setInterval(() => {
            this.checkAndRunOnce();
        }, 5 * 60 * 1000) // check every 5 mins
        runningCheckJobs[pid] = { policy, timer }; // register job
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
        macs = this.getPolicyRelatedMacs(policy);
        const count = await this.getMacsUsedTime(macs);
        log.info(`check policy ${policy.pid} screen time: ${count}, macs: ${macs}`, policy);
        const { threshold }
        if (Number(count) > Number(threshold)) {
            const timeFrame = this.generateTimeFrame(policy);
            const autoPausePid = await this.createRule(policy);
            await this.createAlarm(policy, autoPausePid);
        }
    }
    async createRule(policy) {
        const PM2 = require('../alarm/PolicyManager2.js');
        const pm2 = new PM2();
        const Policy = require('../alarm/Policy.js');
        const policyPayloads = this.generatePolicyPayloads(policy);
        try {
            const { policy } = await pm2.checkAndSaveAsync(new Policy(policyPayload))
            log.info("Auto pause policy is created successfully, pid:", policy.pid);
            return policy.pid
        } catch (err) {
            log.error("Failed to create policy:", err);
        }
    }
    generatePolicyPayloads(policy) {
        const basePayload = { //policyPayload same as payload with app policy:create
            action: 'block',
            target: 'TAG',
            expire: '',
            cronTime: '',
            duration: '',
            tag: [],
            scope: [],
            type: 'mac',
            direction: "bidirection",
            disabled: '0',
            dnsmasq_only: false,
            autoDeleteWhenExpires: '1',
        }
        const scope = policy.scope;
        if (scope && scope.length > 0) {
            for(const ele of scope){

            }
        }
        if (target.includes(MAC_PREFIX)) {
            policyPayload.target = target.split(MAC_PREFIX)[1];
        } else if (target.includes(INTF_PREFIX) || target.includes(TAG_PREFIX)) {
            policyPayload.tag = [target];
        }
        policyPayload.expire = info.expire;
        return policyPayload;
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
            beginOfResetTime, endOfResetTime, expire
        }
    }
    getPolicyRelatedMacs(policy) {
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
    async getMacsUsedTime(macs) {
        if (!macs || macs.length == 0) return 0;
        let count = 0;
        for (const mac of macs) {
            try {
                count += await tracking.getUsedTime(mac);
            } catch (e) { }
        }
        return count;
    }
}

module.exports = new ScreenTime();

