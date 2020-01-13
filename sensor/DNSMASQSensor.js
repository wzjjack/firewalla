/*    Copyright 2016-2020 Firewalla INC
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
const HostManager = require('../net2/HostManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const sem = require('../sensor/SensorEventManager.js').getInstance();

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Mode = require('../net2/Mode.js');

class DNSMASQSensor extends Sensor {
  constructor() {
    super();

    this.registered = false;
    this.started = false;
    this.eventBuffer = [];
  }

  _start() {
    return dnsmasq.install()
      .catch(err => {
        log.error("Fail to install dnsmasq: " + err);
        throw err;
      })
      .then(async () => {
        this.registerLocalDomain();
        dnsmasq.start(false)
      })
      .catch(err => log.error("Failed to start dnsmasq: " + err))
      .then(() => log.info("dnsmasq service is started successfully"));
  }

  _stop() {
    return dnsmasq.stop()
      .catch(err => {
        log.error("Failed to stop dnsmasq: " + err);
        throw err;
      })
      .then(() => log.info("dnsmasq service is stopped successfully"))
      .then(() => require('../util/util.js').delay(1000));
  }

  reload() {
    dnsmasq.needRestart = new Date() / 1000
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      this._run();
    })
  }

  _bufferEvent(event) {
    log.info("Buffering event: " + event.type);
    this.eventBuffer.push(event);
  }

  _emitBufferedEvent() {
    if (this.eventBuffer && this.eventBuffer.length > 0) {
      this.eventBuffer.forEach((event) => {
        sem.emitEvent(event);
      });
    }
  }

  _run() {
    // always start dnsmasq
    return Mode.getSetupMode()
      .then((mode) => {
        dnsmasq.setMode(mode);
        if (!this.registered) {
          log.info("Registering dnsmasq events listeners");

          sem.on("StartDNS", (event) => {
            // NO NEED TO RELOAD DNSMASQ if it's gone, it's going to be managed by systemctl
            // dnsmasq.checkStatus((status) => {
            //   if(!status) {
            //     this.reload();
            //   }
            // })
          });

          sem.on("StopDNS", (event) => {
            // ignore StopDNS, as now it will always start as daemon process
          });

          sem.on("Mode:Applied", (event) => {
            if (!this.started) {
              this._bufferEvent(event);
            } else {
              log.info("Mode applied: " + event.mode);
              dnsmasq.applyMode(event.mode);
            }
          });

          sem.on("ReloadDNSRule", (event) => {
            if (!this.started) {
              this._bufferEvent(event);
            } else {
              this.reload();
            }
          });

          this.registered = true;
        }

        return this._start()
          .then(() => {
            dnsmasq.applyMode(mode);
            this.started = true;
            this._emitBufferedEvent();
          })
      })
  }
  async registerLocalDomain() {
    const hostManager = new HostManager("cli", 'client', 'info');
    const hosts = await hostManager.getHostsAsync();
    let pureHosts = [];
    for (const host of hosts) {
      if (host && host.o) {
        pureHosts.push(host.o)
      }
    }
    dnsmasq.setupLocalDeviceDomain(false, pureHosts, true);
  }
}

module.exports = DNSMASQSensor;
