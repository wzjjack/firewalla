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
const cc = require('../extension/cloudcache/cloudcache.js');
const country = require('../extension/country/country.js');
const zlib = require('zlib');
const fs = require('fs');
const f = require('../net2/Firewalla.js');
const countryDataFolder = `${f.getRuntimeInfoFolder()}/countryData`;
const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);
const Buffer = require('buffer').Buffer;

const hashData = [{
    hashKey: "mmdb:ipv4",
    dataPath: `${countryDataFolder}/geoip-country.dat`,
    type: "ipv4"
}, {
    hashKey: "mmdb:ipv6",
    dataPath: `${countryDataFolder}/geoip-country6.dat`,
    type: "ipv6"
}]
const featureName = "country";
class CountryIntelPlugin extends Sensor {
    async run() {
        this.hookFeature(featureName);
    }
    async globalOn() {
        country.updateGeodatadir(countryDataFolder);
        for (const item of hashData) {
            try {
                await cc.enableCache(item.hashKey, (data) => {
                    this.loadCountryData(item, data);
                });
            } catch (err) {
                log.error("Failed to process country data:", item.hashKey);
            }
        }
    }
    // process country data and use on geoip-lite
    async loadCountryData(item, content) {
        try {
            if (!content || content.length < 10) {
                // likely invalid, return null for protection
                log.error(`Invalid country data content for ${item.hashKey}, ignored`);
                return;
            }
            const buf = Buffer.from(content, 'base64');
            const data = await inflateAsync(buf);
            await fs.writeFileAsync(item.dataPath, data);
            log.info(`Loaded Country Data ${item.hashKey} successfully.`);
            country.reloadDataSync(item.type);
            for (var i of ["123.58.180.7", "151.101.73.67", "97.64.107.97", "1.1.1.1"]) {
                log.info("jack test country", i, country.getCountry(i))
            }
        } catch (err) {
            log.error("Failed to update country data, err:", err);
        }
    }
    async globalOff() {
        for (const item of hashData) {
            await cc.disableCache(item.hashKey);
        }
        country.updateGeodatadir();
        country.reloadDataSync();
    }
}

module.exports = CountryIntelPlugin;
