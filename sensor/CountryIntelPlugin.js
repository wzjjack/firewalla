/*    Copyright 2021 Firewalla LLC
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

const _ = require('lodash');

const fc = require('../net2/config.js');

const f = require('../net2/Firewalla.js');

const BloomFilter = require('../vendor_lib/bloomfilter.js').BloomFilter;

const cc = require('../extension/cloudcache/cloudcache.js');

const zlib = require('zlib');
const fs = require('fs');

const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);

const Buffer = require('buffer').Buffer;

const hashKeys = ["mmdb:ipv4", "mmdb:ipv6"];
const featureName = "country";

class CountryIntelPlugin extends Sensor {
    async run() {
        this.hookFeature(featureName);
    }
    async globalOn() {
        for (const hashKeyName of hashKeys) {
            try {
                await cc.enableCache(hashKeyName, (data) => {
                    this.loadCountryData(hashKeyName, data);
                });
            } catch (err) {
                log.error("Failed to process country data:", hashKeyName);
            }
        }
    }
    // process country data and use on geoip-lite
    async loadCountryData(hashKeyName, content) {
        try {
            if (!content || content.length < 10) {
                // likely invalid, return null for protection
                log.error(`Invalid country data content for ${hashKeyName}, ignored`);
                return;
            }

            const buf = Buffer.from(content, 'base64');
            const data = await inflateAsync(buf);
            const dataString = data.toString();
            log.info(`Loaded Country Data ${hashKeyName} successfully.`);
            log.info('jack test', dataString)
        } catch (err) {
            log.error("Failed to update bf data, err:", err);
        }
    }

    async globalOff() {
        for (const hashKeyName of hashKeys) {
            await cc.disableCache(hashKeyName);
        }
    }
}

module.exports = CountryIntelPlugin;
