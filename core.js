const bufferreader = require('./reader');
const opcodes = require('./opcodes');
function parseproto(r, strings, version) {
    let maxstacksize = r.readbyte();
    let numparams = r.readbyte();
    let numupvalues = r.readbyte();
    let isvararg = r.readbyte();
    if (version >= 4) {
        r.readbyte(); 
        let typesize = r.readvarint();
        r.offset += typesize; 
    }
    let instrcount = r.readvarint();
    let instrs = [];
    for (let i = 0; i < instrcount; i++) {
        instrs.push(r.readint32());
    }
    let constcount = r.readvarint();
    let consts = [];
    for (let i = 0; i < constcount; i++) {
        let type = r.readbyte();
        if (type === 0) {
            consts.push("nil");
        } else if (type === 1) {
            consts.push(r.readbyte() === 1 ? "true" : "false");
        } else if (type === 2) {
            consts.push(r.buffer.readDoubleLE(r.offset));
            r.offset += 8;
        } else if (type === 3) {
            let id = r.readvarint();
            consts.push('"' + (strings[id - 1] || "") + '"');
        } else if (type === 4) {
            consts.push("[import " + r.readint32() + "]");
        } else if (type === 5) {
            let tsize = r.readvarint();
            for (let j = 0; j < tsize; j++) r.readvarint();
            consts.push("{table}");
        } else if (type === 6) {
            consts.push("[closure " + r.readvarint() + "]");
        } else if (type === 7) {
            r.offset += 16;
            consts.push("vector");
        } else {
            consts.push("unknown");
        }
    }
    let protocount = r.readvarint();
    let protos = [];
    for (let i = 0; i < protocount; i++) {
        protos.push(r.readvarint());
    }
    r.readvarint(); 
    let nameid = r.readvarint();
    let protoname = nameid > 0 ? strings[nameid - 1] : "anonymous";
    if (r.readbyte() === 1) {
        r.readbyte();
        let intervals = ((instrcount - 1) >> 1) + 1; 
        r.offset += (instrcount + (intervals * 4));
    }
    if (r.readbyte() === 1) {
        let locs = r.readvarint();
        for (let i = 0; i < locs; i++) {
            r.readvarint(); r.readvarint(); r.readvarint(); r.readbyte();
        }
        let upvs = r.readvarint();
        for (let i = 0; i < upvs; i++) r.readvarint();
    }
    return { instrs, consts, protoname };
}
function process(base64str) {
    let buf = Buffer.from(base64str, 'base64');
    let r = new bufferreader(buf);
    let version = r.readbyte();
    if (version < 3 || version > 7) return "error version " + version + " not supported";
    if (version >= 4) r.readbyte(); 
    let stringcount = r.readvarint();
    let strings = [];
    for (let i = 0; i < stringcount; i++) {
        strings.push(r.readstring(r.readvarint()));
    }
    let protocount = r.readvarint();
    let allprotos = [];
    for (let i = 0; i < protocount; i++) {
        allprotos.push(parseproto(r, strings, version));
    }
    let mainindex = r.readvarint();
    let output = "-- meggd disassembly v1.1\n\n";
    for (let i = 0; i < allprotos.length; i++) {
        let p = allprotos[i];
        output += "function " + p.protoname + "() -- id: " + i + "\n";
        for (let inst = 0; inst < p.instrs.length; inst++) {
            let raw = p.instrs[inst];
            let op = raw & 0xFF;
            let name = opcodes[op] || "op_" + op;
            output += "  [" + inst + "] " + name + " (raw: " + raw + ")\n";
        }
        output += "end\n\n";
    }
    return output;
}
module.exports = { process };
