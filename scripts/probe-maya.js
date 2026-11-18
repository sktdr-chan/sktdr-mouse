'use strict';
const HID = require('node-hid');
const VID = 0x3554, PID = 0xf50d;
const cols = HID.devices().filter(d => d.vendorId === VID && d.productId === PID && (d.usagePage||0) === 0xff02);
if (!cols.length) { console.log('FF02 not found'); process.exit(1); }
const dev = new HID.HID(cols[0].path);

function cksum(p) { let s=0; for(let i=0;i<15;i++) s+=p[i]; return ((0x55-s-8)%256+256)%256; }
function pkt(cmd, addr, len, data) {
  const p = Buffer.alloc(16,0); p[0]=cmd; p[2]=(addr>>8)&0xff; p[3]=addr&0xff; p[4]=len;
  for(let i=0;i<Math.min(data.length,10);i++) p[5+i]=data[i]&0xff;
  p[15]=cksum(p); return p;
}
function tryCmd(cmd, addr, len, data, label) {
  const p = pkt(cmd, addr, len, data);
  try { dev.write(Buffer.from([8, ...p])); } catch(e) { console.log(label+': write failed'); return; }
  let raw;
  try { raw = dev.readTimeout(500); } catch(e) { console.log(label+': timeout'); return; }
  const buf = Buffer.from(raw);
  const res = buf[0]===8 ? buf.slice(1,17) : buf.slice(0,16);
  console.log(label + ': ' + [...res.slice(0,20)].map(b=>b.toString(16).padStart(2,'0')).join(' '));
}
tryCmd(0x1d, 0, 0, [], 'dongleVer ');
tryCmd(0x03, 0, 0, [], 'online    ');
tryCmd(0x04, 0, 0, [], 'battery   ');
tryCmd(0x01, 0, 8, [1,2,3,4,0,0,0,0], 'handshake ');
tryCmd(0x12, 0, 0, [], 'mouseVer  ');
tryCmd(0x08, 0x000c, 10, [], 'readFlash@C');
dev.close();
