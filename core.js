const bufferreader = require('./reader');
const opcodes = require('./opcodes');

function parseproto(r, strings, version) {
    let maxstacksize = r.readbyte();
    let numparams = r.readbyte();
    let numupvalues = r.readbyte();
    let isvararg = r.readbyte();

    if (version >= 4) {
        let flags = r.readbyte();
        let typesize = r.readvarint();
        for (let i = 0; i < typesize; i++) {
            r.readbyte();
        }
    }

    let instrcount = r.readvarint();
    let instrs =[];
    for (let i = 0; i < instrcount; i++) {
        instrs.push(r.readint32());
    }

    let constcount = r.readvarint();
    let consts =[];
    for (let i = 0; i < constcount; i++) {
        let type = r.readbyte();
        if (type === 0) {
            consts.push("nil");
        } else if (type === 1) {
            consts.push(r.readbyte() === 1 ? "true" : "false");
        } else if (type === 2) {
            let num = r.buffer.readDoubleLE(r.offset);
            r.offset += 8;
            consts.push(num);
        } else if (type === 3) {
            let id = r.readvarint();
            consts.push(`"${strings[id - 1]}"`);
        } else if (type === 4) {
            let id = r.readint32();
            consts.push(`[Import ID: ${id}]`);
        } else if (type === 5) {
            let size = r.readvarint();
            for (let j = 0; j < size; j++) {
                r.readvarint();
            }
            consts.push("{table}");
        } else if (type === 6) {
            let id = r.readvarint();
            consts.push(`[Closure ID: ${id}]`);
        } else if (type === 7) {
            r.offset += 16;
            consts.push("Vector3.new(...)");
        } else {
            consts.push(`[Unknown Constant Type: ${type}]`);
        }
    }

    let protocount = r.readvarint();
    let protos =[];
    for (let i = 0; i < protocount; i++) {
        protos.push(r.readvarint());
    }

    let linedefined = r.readvarint();
    let nameid = r.readvarint();
    let protoname = nameid > 0 ? strings[nameid - 1] : "main";

    let haslineinfo = r.readbyte();
    if (haslineinfo === 1) {
        let linegaplog2 = r.readbyte();
        let intervals = ((instrcount - 1) >> linegaplog2) + 1;
        r.offset += instrcount;
        r.offset += intervals * 4;
    }

    let hasdebug = r.readbyte();
    if (hasdebug === 1) {
        let loccount = r.readvarint();
        for (let i = 0; i < loccount; i++) {
            r.readvarint(); r.readvarint(); r.readvarint(); r.readbyte();
        }
        let upvcount = r.readvarint();
        for (let i = 0; i < upvcount; i++) {
            r.readvarint();
        }
    }

    return { maxstacksize, numparams, numupvalues, isvararg, instrs, consts, protos, protoname };
}

function process(base64str) {
    let buf = Buffer.from(base64str, 'base64');
    let r = new bufferreader(buf);

    let version = r.readbyte();
    if (version === 0) return "-- error: invalid bytecode (version 0)";

    let typesversion = 0;
    if (version >= 4) typesversion = r.readbyte();

    let stringcount = r.readvarint();
    let strings =[];
    for (let i = 0; i < stringcount; i++) {
        let len = r.readvarint();
        strings.push(r.readstring(len));
    }

    if (typesversion === 3) {
        let index = r.readbyte();
        while (index !== 0) {
            r.readvarint();
            index = r.readbyte();
        }
    }

    let protocount = r.readvarint();
    let allprotos =[];
    for (let i = 0; i < protocount; i++) {
        allprotos.push(parseproto(r, strings, version));
    }

    let mainindex = r.readvarint();
    
    let output = `-- MEGGD Engine v1.0\n-- Luau Bytecode Version: ${version}\n-- Parsed Prototypes: ${allprotos.length}\n\n`;
    
    for (let i = 0; i < allprotos.length; i++) {
        let p = allprotos[i];
        output += `function ${p.protoname}() -- [Prototype ${i}]\n`;
        
        output += `  -- Constants (${p.consts.length}):\n`;
        for (let c = 0; c < p.consts.length; c++) {
            output += `  -- K[${c}] = ${p.consts[c]}\n`;
        }
        
        output += `\n  -- Instructions (${p.instrs.length}):\n`;
        for (let inst = 0; inst < p.instrs.length; inst++) {
            let raw = p.instrs[inst];
            let op = raw & 0xFF;
            
            let opname = opcodes[op] || `UNKNOWN_OP_${op}`;
            
            let A = (raw >> 8) & 0xFF;
            let B = (raw >> 16) & 0xFF;
            let C = (raw >> 24) & 0xFF;
            let Bx = (raw >> 16) & 0xFFFF;
            
            output += `  [${inst}] ${opname} \tA: ${A} \tB: ${B} \tC: ${C} \tBx: ${Bx}\n`;
        }
        output += `end\n\n`;
    }

    return output;
}

module.exports = { process };
