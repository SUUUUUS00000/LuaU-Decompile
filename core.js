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
    let instrs =[];
    for (let i = 0; i < instrcount; i++) {
        instrs.push(r.readuint32());
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
            consts.push(r.buffer.readDoubleLE(r.offset));
            r.offset += 8;
        } else if (type === 3) {
            let id = r.readvarint();
            consts.push(strings[id - 1] || "");
        } else if (type === 4) {
            let id = r.readint32();
            let count = id >>> 30;
            let arr =[];
            if (count > 0) arr.push(consts[(id >> 20) & 1023]);
            if (count > 1) arr.push(consts[(id >> 10) & 1023]);
            if (count > 2) arr.push(consts[id & 1023]);
            consts.push(arr.join("."));
        } else if (type === 5) {
            let tsize = r.readvarint();
            for (let j = 0; j < tsize; j++) r.readvarint();
            consts.push("{}");
        } else if (type === 6) {
            consts.push({ isClosure: true, id: r.readvarint() });
        } else if (type === 7) {
            r.offset += 16;
            consts.push("Vector3.new()");
        } else {
            consts.push("unknown");
        }
    }
    let protocount = r.readvarint();
    let protos =[];
    for (let i = 0; i < protocount; i++) {
        protos.push(r.readvarint());
    }
    let linedefined = r.readvarint();
    let nameid = r.readvarint();
    let protoname = nameid > 0 ? strings[nameid - 1] : "anonymous";
    let haslineinfo = r.readbyte();
    if (haslineinfo === 1) {
        let linegaplog2 = r.readbyte();
        let intervals = ((instrcount - 1) >> linegaplog2) + 1;
        r.offset += instrcount;
        r.offset += intervals * 4;
    }
    let hasdebug = r.readbyte();
    if (hasdebug === 1) {
        let locs = r.readvarint();
        for (let i = 0; i < locs; i++) {
            r.readvarint();
            r.readvarint();
            r.readvarint();
            r.readbyte();
        }
        let upvs = r.readvarint();
        for (let i = 0; i < upvs; i++) r.readvarint();
    }
    return { maxstacksize, numparams, numupvalues, isvararg, instrs, consts, protos, protoname };
}

function lift(p, allprotos) {
    let lines =[];
    let regs = new Array(256).fill("nil");
    let pc = 0;
    while (pc < p.instrs.length) {
        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >> 8) & 0xFF;
        let b = (raw >> 16) & 0xFF;
        let c = (raw >> 24) & 0xFF;
        let bx = (raw >> 16) & 0xFFFF;
        let sbx = bx - 32768;
        try {
            if (opname === "LOADNIL") regs[a] = "nil";
            else if (opname === "LOADB") regs[a] = b === 1 ? "true" : "false";
            else if (opname === "LOADN") regs[a] = sbx;
            else if (opname === "LOADK") {
                let v = p.consts[bx];
                regs[a] = typeof v === "string" ? `"${v}"` : v;
            }
            else if (opname === "LOADKX") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                let v = p.consts[aux];
                regs[a] = typeof v === "string" ? `"${v}"` : v;
            }
            else if (opname === "MOVE") regs[a] = regs[b];
            else if (opname === "GETGLOBAL") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                regs[a] = p.consts[aux];
            }
            else if (opname === "SETGLOBAL") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                lines.push(`${p.consts[aux]} = ${regs[a]}`);
            }
            else if (opname === "GETIMPORT") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                regs[a] = p.consts[aux];
            }
            else if (opname === "GETTABLE") regs[a] = `${regs[b]}[${regs[c]}]`;
            else if (opname === "GETTABLEKS") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                regs[a] = `${regs[b]}.${p.consts[aux]}`;
            }
            else if (opname === "SETTABLE") lines.push(`${regs[b]}[${regs[c]}] = ${regs[a]}`);
            else if (opname === "SETTABLEKS") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                lines.push(`${regs[b]}.${p.consts[aux]} = ${regs[a]}`);
            }
            else if (opname === "NAMECALL") {
                let aux = p.instrs[++pc] & 0xFFFFFF;
                regs[a] = { m: true, obj: regs[b], func: p.consts[aux] };
                regs[a + 1] = regs[b];
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args =[];
                let argcount = b - 1;
                if (f && f.m) {
                    for (let i = 2; i <= argcount; i++) args.push(regs[a + i]);
                    let cs = `${f.obj}:${f.func}(${args.join(", ")})`;
                    if (c - 1 === 0) lines.push(cs); else regs[a] = cs;
                } else {
                    for (let i = 1; i <= argcount; i++) args.push(regs[a + i]);
                    let cs = `${f}(${args.join(", ")})`;
                    if (c - 1 === 0) lines.push(cs); else regs[a] = cs;
                }
            }
            else if (opname === "NEWCLOSURE") regs[a] = allprotos[bx].code;
            else if (opname === "DUPCLOSURE") regs[a] = allprotos[p.consts[bx].id].code;
            else if (opname === "RETURN") {
                if (b > 1) {
                    let r =[];
                    for (let i = 0; i < b - 1; i++) r.push(regs[a + i]);
                    lines.push(`return ${r.join(", ")}`);
                } else if (b === 0) {
                    lines.push(`return ...`);
                }
            }
            else if (opname === "JUMPIF" || opname === "JUMPIFNOT") {
                let cnd = opname === "JUMPIF" ? regs[a] : `not ${regs[a]}`;
                lines.push(`if ${cnd} then`);
            }
            else if (opname === "ADD") regs[a] = `${regs[b]} + ${regs[c]}`;
            else if (opname === "SUB") regs[a] = `${regs[b]} - ${regs[c]}`;
            else if (opname === "MUL") regs[a] = `${regs[b]} * ${regs[c]}`;
            else if (opname === "DIV") regs[a] = `${regs[b]} / ${regs[c]}`;
            else if (opname === "NEWTABLE") { regs[a] = "{}"; pc++; }
            else if (opname === "DUPTABLE") regs[a] = "{}";
            else if (opname === "GETVARARGS") regs[a] = "...";
            else if (opname === "GETUPVAL") regs[a] = `upval_${b}`;
            else if (opname === "SETUPVAL") lines.push(`upval_${b} = ${regs[a]}`);
        } catch (e) {}
        pc++;
    }
    return lines.join("\n");
}

function process(base64str) {
    let buf = Buffer.from(base64str, 'base64');
    let r = new bufferreader(buf);
    let version = r.readbyte();
    if (version < 3 || version > 7) return "-- error invalid version " + version;
    let typesversion = 0;
    if (version >= 4) typesversion = r.readbyte();
    let stringcount = r.readvarint();
    let strings =[];
    for (let i = 0; i < stringcount; i++) {
        strings.push(r.readstring(r.readvarint()));
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
    if (!allprotos[mainindex]) return "-- error desync mainindex";
    for (let i = allprotos.length - 1; i >= 0; i--) {
        let p = allprotos[i];
        let body = lift(p, allprotos);
        let args =[];
        for (let a = 0; a < p.numparams; a++) args.push(`arg_${a}`);
        if (p.isvararg) args.push("...");
        p.code = `function(${args.join(", ")})\n${body.replace(/^/gm, "    ")}\nend`;
    }
    return lift(allprotos[mainindex], allprotos);
}

module.exports = { process };
