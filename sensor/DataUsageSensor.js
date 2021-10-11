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
const Promise = require('bluebird');
const zlib = require('zlib');
const deflateAsync = Promise.promisify(zlib.deflate);
const { Readable, Writable } = require('stream');
const fs = require('fs');
// (async () => {
//   // Node.js program to demonstrate the     
//   // createDeflate() method



//   // Creating readable Stream
//   const inp = fs.createReadStream('input.txt');


// })()


(async () => {
  console.log("jack test")
  let testData = [{
    "ts": 1633945865.392,
    "fd": "in",
    "count": 1,
    "duration": 10.17,
    "intf": "5aca1e36-d1e3-4f4f-b10a-1fe13eb8cb15",
    "tags": [],
    "device": "DC:A9:04:84:64:E7",
    "protocol": "tcp",
    "port": 443,
    "devicePort": 60827,
    "ip": "59.111.183.194",
    "deviceIP": "192.168.18.85",
    "upload": 1510,
    "download": 4050,
    "country": "CN",
    "host": "note.youdao.com",
    "deviceName": "MBP",
    "macVendor": "Apple",
    "tagIds": [],
    "networkName": "LAN",
    "onWan": false,
    "intfInfo": {
      "name": "LAN",
      "type": "lan",
      "uuid": "5aca1e36-d1e3-4f4f-b10a-1fe13eb8cb15"
    },
    "enrichPorts": [
      {
        "port": 443,
        "portName": "https",
        "portDescription": "http protocol over TLS/SSL"
      }
    ],
    "type": "ip",
    "total": null
  },
  {
    "ts": 1633945854.392,
    "fd": "in",
    "count": 1,
    "duration": 19.98,
    "intf": "5aca1e36-d1e3-4f4f-b10a-1fe13eb8cb15",
    "tags": [],
    "device": "DC:A9:04:84:64:E7",
    "protocol": "tcp",
    "port": 443,
    "devicePort": 60819,
    "ip": "59.111.183.188",
    "deviceIP": "192.168.18.85",
    "upload": 1451,
    "download": 3588,
    "country": "CN",
    "host": "note.youdao.com",
    "deviceName": "MBP",
    "macVendor": "Apple",
    "tagIds": [],
    "networkName": "LAN",
    "onWan": false,
    "intfInfo": {
      "name": "LAN",
      "type": "lan",
      "uuid": "5aca1e36-d1e3-4f4f-b10a-1fe13eb8cb15"
    },
    "enrichPorts": [
      {
        "port": 443,
        "portName": "https",
        "portDescription": "http protocol over TLS/SSL"
      }
    ],
    "type": "ip",
    "total": null
  }]
  for (var i = 0; i < 5; i++) {
    testData = testData.concat(testData)
  }
  console.log('test data length', testData.length)
  const str = JSON.stringify(testData)
  console.log('raw size', str.length)
  const deflateBuffer = await deflateAsync(str)
  const base64Str = deflateBuffer.toString('base64')
  console.log('compressed size deflateBuffer and base64str', deflateBuffer.length, base64Str.length);
  (async () => {
    console.log('func1');
    const outStream = new Writable({
      write() { }
    })
    const inStream = new Readable({
      read() { }
    });
    var t = 0;
    for (const f of testData) {
      // setTimeout(() => {
      //   inStream.push(JSON.stringify(f))
      // }, t * 1000)
      // t = t + 10
      inStream.push(JSON.stringify(f))
    }
    inStream.push(null)
    // Creating writable stream
    const out = fs.createWriteStream('input1.txt');

    // Calling createDeflate method
    const def = zlib.createDeflate();

    // Piping
    inStream.pipe(def).pipe(out);
    console.log("Program Completed!");
    // setTimeout(() => {
    //   inStream.push(null)
    // }, 1 * 60 * 60 * 1000)
    // inStream.push(null)

    // console.log("jack test goto defalte")
    // inStream.pipe(zlib.createDeflate).pipe(outStream)
    // const buff = inStream.pipe(zlib.createDeflate).pipe(process.stdout)
    // console.log("jack test buff", buff.length)
    // console.log("jack test tostring", buff.toString('base64').length)
  })()

})()