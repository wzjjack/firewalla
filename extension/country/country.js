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
global.geodatadir = `${__dirname}/data`;
const geoip = require('../../vendor_lib/geoip-lite/geoip');
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const log = require('../../net2/logger.js')(__filename);
let instance = null;
class Country {
    constructor() {
        if (instance == null) {
            instance = this;
            this.geoip = geoip;
            sem.on('GEO_DAT_CHANGE', (event) => {
                this.updateGeodatadir(event.dir)
            });
            sem.on('GEO_REFRESH', (event) => {
                this.reloadDataSync(event.dataType)
            });
        }
        return instance;
    }
    getCountry(ip) {
        const result = this.geoip.lookup(ip);
        if (result) {
            return result.country;
        }
        return null;
    }
    reloadDataSync(type) {
      log.info("jack test updateGeodatadir");
        this.geoip.reloadDataSync(type)
        log.info("jack test lalala",geoip.lookup("91.199.81.0"));
    }
    updateGeodatadir(dir) {
      log.info("jack test updateGeodatadir");
        this.geoip.updateGeodatadir(dir ? dir : `${__dirname}/data`);
        log.info("jack test lalala",geoip.lookup("91.199.81.0"));
    }
}

module.exports = new Country();
