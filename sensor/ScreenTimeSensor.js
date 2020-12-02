/*    Copyright 2020 Firewalla Inc
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')

const fc = require('../net2/config.js');

const featureName = "screentime";
const policyKeyName = "screentime";
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const platform = require('../platform/PlatformLoader.js').getPlatform();
const Policy = require('../alarm/Policy.js');
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const INTF_PREFIX = "intf:";
const TAG_PREFIX = "tag:";
const MAC_PREFIX = "mac:"
const tracking = require('../extension/accounting/tracking.js');

class ScreenTimeSensor extends Sensor {
    constructor() {
        super();
        this.screenTimeSettings = {}
    }
    async run() {
        /*
         screentime:{
            threshold
            resetTime
            enable
         }
        */
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy
        });
        let interval = this.config.interval * 1000 || 5 * 60 * 1000; // 5 mins
        setInterval(async () => {
            for (const key of this.screenTimeSettings) {
                try {
                    await this.checkAndRunOnce(key, this.screenTimeSettings[key]);
                } catch (err) {
                    log.error("Got error when check device screen time", err);
                }
            }
        }, interval);
    }
    async applyPolicy(host, ip, policy) {
        log.info("Applying device screen time policy:", ip, policy);
        try {
            let settingKey, allMacs = [];
            if (ip === '0.0.0.0') {
                settingKey = '0.0.0.0';
                allMacs = hostManager.getActiveMACs();
            } else {
                if (!host)
                    return;
                switch (host.constructor.name) {
                    case "Tag": {
                        const tagUid = host.o && host.o.uid;
                        if (tagUid) {
                            settingKey = `${TAG_PREFIX}${tagUid}`;
                            allMacs = hostManager.getTagMacs(tagUid);
                        }
                        break;
                    }
                    case "NetworkProfile": {
                        const uuid = host.o && host.o.uuid;
                        if (uuid) {
                            settingKey = `${INTF_PREFIX}${uuid}`;
                            allMacs = hostManager.getIntfMacs(uuid);
                        }
                        break;
                    }
                    case "Host": {
                        if (host.o && host.o.mac) {
                            settingKey = `${MAC_PREFIX}${host.o && host.o.mac}`;
                            allMacs = [settingKey]
                        }
                        break;
                    }
                    default:
                }
            }
            if (settingKey) {
                policy.allMacs = allMacs;
                this.screenTimeSettings[settingKey] = policy;
                await this.checkAndRunOnce(settingKey, policy);
            }
        } catch (err) {
            log.error("Got error when applying device screen time policy", err);
        }
    }
    dependFeatureEnabled() {
        if (!platform.isAccountingSupported() || !fc.isFeatureOn("accounting")) {
            log.info("Accounting feature is not supported or disabled.");
            return false;
        }
        return true;
    }
    async checkAndRunOnce(key, policy) {
        if (!this.dependFeatureEnabled()) return;
        if (!fc.isFeatureOn(featureName)) return;
        if (!policy.enable) return;
        const { threshold, resetTime, allMacs } = policy;
        const count = await this.getMacsUsedTime(allMacs);
        if (Number(count) > Number(threshold)) {
            await this.createAlarm();
            await this.createRule(key, policy);
        }
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
    async createAlarm() {

    }
    async createRule(target, info) {
        const policyPayload = this.generatePolicyPayload(target, info);
        try {
            const { policy } = await pm2.checkAndSaveAsync(new Policy(policyPayload))
            log.info("Auto pause policy is created successfully, pid:", policy.pid);
        } catch (err) {
            log.error("Failed to create policy:", err)
        }
    }
    generatePolicyPayload(target, info) {
        const resetTime = info.resetTime || 0;
        const policyPayload = { //policyPayload same as payload with app policy:create
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
        if (target.includes(MAC_PREFIX)) {
            policyPayload.target = target.split(MAC_PREFIX)[1];
        } else if (target.includes(INTF_PREFIX) || target.includes(TAG_PREFIX)) {
            policyPayload.tag = [target];
        }
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
        policyPayload.expire = endOfResetTime / 1000 - now / 1000;
    }
}

module.exports = ScreenTimeSensor
