const bufferreader = require('./reader');
const opcodes = require('./opcodes');
function parseproto(r, strings, version) {
    let maxstacksize = r.readbyte();
    let numparams = r.readbyte();
    let numupvalues = r.readbyte();
    let isvararg = r.readbyte();
    if (version >= 4) {
        r.readbyte();
        r.offset += r.readvarint();
    }
    let instrcount = r.readvarint();
    let instrs =[];
    for (let i = 0; i < instrcount; i++) instrs.push(r.readuint32());
    let constcount = r.readvarint();
    let consts =[];
    for (let i = 0; i < constcount; i++) {
        let type = r.readbyte();
        if (type === 0) consts.push({ t: 'nil', v: 'nil' });
        else if (type === 1) consts.push({ t: 'bool', v: r.readbyte() === 1 });
        else if (type === 2) { consts.push({ t: 'num', v: r.buffer.readDoubleLE(r.offset) }); r.offset += 8; }
        else if (type === 3) consts.push({ t: 'str', v: strings[r.readvarint() - 1] || "" });
        else if (type === 4) {
            let id = r.readuint32();
            let count = id >>> 30;
            let arr =[];
            let getval = (idx) => { let c = consts[idx]; return c ? (c.t === 'str' ? c.v : c.v) : ""; };
            if (count > 0) arr.push(getval((id >> 20) & 1023));
            if (count > 1) arr.push(getval((id >> 10) & 1023));
            if (count > 2) arr.push(getval(id & 1023));
            consts.push({ t: 'import', v: arr.join(".") });
        }
        else if (type === 5) { let sz = r.readvarint(); for(let j=0; j<sz; j++) r.readvarint(); consts.push({ t: 'table', v: '{}' }); }
        else if (type === 6) consts.push({ t: 'closure', id: r.readvarint() });
        else if (type === 7) { r.offset += 16; consts.push({ t: 'vector', v: 'Vector3.new()' }); }
        else consts.push({ t: 'unk', v: 'unknown' });
    }
    let protocount = r.readvarint();
    let protos =[];
    for (let i = 0; i < protocount; i++) protos.push(r.readvarint());
    let linedefined = r.readvarint();
    let nameid = r.readvarint();
    let protoname = nameid > 0 ? strings[nameid - 1] : "anonymous";
    if (r.readbyte() === 1) {
        let linegap = r.readbyte();
        let intervals = ((instrcount - 1) >> linegap) + 1;
        r.offset += instrcount + (intervals * 4);
    }
    if (r.readbyte() === 1) {
        let locs = r.readvarint();
        for (let i = 0; i < locs; i++) { r.readvarint(); r.readvarint(); r.readvarint(); r.readbyte(); }
        let upvs = r.readvarint();
        for (let i = 0; i < upvs; i++) r.readvarint();
    }
    return { numparams, isvararg, instrs, consts, protos, protoname };
}
function formatK(k) {
    if (!k) return "nil";
    if (k.t === 'str') return `"${k.v}"`;
    return k.v;
}
function formatKVal(k) {
    if (!k) return "nil";
    return k.v;
}
function lift(p, allprotos, indnt) {
    let lines =[];
    let regs = new Array(256).fill("nil");
    let pc = 0;
    let endScopes = {};
    let push = (str) => { lines.push("    ".repeat(indnt) + str); };
    while (pc < p.instrs.length) {
        if (endScopes[pc]) {
            indnt = Math.max(0, indnt - endScopes[pc]);
            for(let i=0; i<endScopes[pc]; i++) push("end");
        }
        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >>> 8) & 0xFF;
        let b = (raw >>> 16) & 0xFF;
        let c = (raw >>> 24) & 0xFF;
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx - 32768;
        try {
            if (opname === "LOADNIL") regs[a] = "nil";
            else if (opname === "LOADB") regs[a] = b === 1 ? "true" : "false";
            else if (opname === "LOADN") regs[a] = sbx;
            else if (opname === "LOADK") regs[a] = formatK(p.consts[bx]);
            else if (opname === "LOADKX") regs[a] = formatK(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF]);
            else if (opname === "MOVE") regs[a] = regs[b];
            else if (opname === "GETGLOBAL") regs[a] = formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF]);
            else if (opname === "SETGLOBAL") push(`${formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF])} = ${regs[a]}`);
            else if (opname === "GETIMPORT") regs[a] = formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF]);
            else if (opname === "GETTABLE") regs[a] = `${regs[b]}[${regs[c]}]`;
            else if (opname === "GETTABLEKS") regs[a] = `${regs[b]}.${formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF])}`;
            else if (opname === "SETTABLE") push(`${regs[b]}[${regs[c]}] = ${regs[a]}`);
            else if (opname === "SETTABLEKS") push(`${regs[b]}.${formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF])} = ${regs[a]}`);
            else if (opname === "NAMECALL") {
                let func = formatKVal(p.consts[(p.instrs[++pc] >>> 0) & 0xFFFFFF]);
                regs[a] = { m: true, obj: regs[b], func: func };
                regs[a + 1] = regs[b];
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args =[];
                let argcount = b - 1;
                if (f && f.m) {
                    for (let i = 2; i <= argcount; i++) args.push(regs[a + i]);
                    let callStr = `${f.obj}:${f.func}(${args.join(", ")})`;
                    if (c - 1 === 0) push(callStr); else regs[a] = callStr;
                } else {
                    for (let i = 1; i <= argcount; i++) args.push(regs[a + i]);
                    let callStr = `${f}(${args.join(", ")})`;
                    if (c - 1 === 0) push(callStr); else regs[a] = callStr;
                }
            }
            else if (opname === "RETURN") {
                if (b > 1) {
                    let r =[];
                    for (let i = 0; i < b - 1; i++) r.push(regs[a + i]);
                    push(`return ${r.join(", ")}`);
                } else if (b === 0) push(`return ...`);
            }
            else if (opname === "JUMPIF" || opname === "JUMPIFNOT") {
                let cnd = opname === "JUMPIF" ? regs[a] : `not ${regs[a]}`;
                push(`if ${cnd} then`);
                let target = pc + sbx + 1;
                endScopes[target] = (endScopes[target] || 0) + 1;
                indnt++;
            }
            else if (opname === "ADD") regs[a] = `${regs[b]} + ${regs[c]}`;
            else if (opname === "SUB") regs[a] = `${regs[b]} - ${regs[c]}`;
            else if (opname === "MUL") regs[a] = `${regs[b]} * ${regs[c]}`;
            else if (opname === "DIV") regs[a] = `${regs[b]} / ${regs[c]}`;
            else if (opname === "GETUPVAL") regs[a] = `upval_${b}`;
            else if (opname === "SETUPVAL") push(`upval_${b} = ${regs[a]}`);
            else if (opname === "NEWCLOSURE") regs[a] = allprotos[bx] ? allprotos[bx].code : "function() end";
            else if (opname === "DUPCLOSURE") regs[a] = allprotos[p.consts[bx].id] ? allprotos[p.consts[bx].id].code : "function() end";
            else if (opname === "NEWTABLE" || opname === "DUPTABLE") { regs[a] = "{}"; if (opname === "NEWTABLE") pc++; }
            else if (opname === "GETVARARGS") regs[a] = "...";
            else if (opname === "JUMPBACK") {
                push("end");
                indnt = Math.max(0, indnt - 1);
            }
        } catch (e) {}
        pc++;
    }
    return lines.join("\n");
}
function process(base64str) {
    let buf = Buffer.from(base64str, 'base64');
    let r = new bufferreader(buf);
    let version = r.readbyte();
    if (version < 3 || version > 7) return "-- error invalid bytecode";
    if (version >= 4) r.readbyte();
    let stringcount = r.readvarint();
    let strings =[];
    for (let i = 0; i < stringcount; i++) strings.push(r.readstring(r.readvarint()));
    if (version >= 4 && r.buffer[r.offset] === 3) {
        let index = r.readbyte();
        while (index !== 0) { r.readvarint(); index = r.readbyte(); }
    }
    let protocount = r.readvarint();
    let allprotos =[];
    for (let i = 0; i < protocount; i++) allprotos.push(parseproto(r, strings, version));
    let mainindex = r.readvarint();
    for (let i = allprotos.length - 1; i >= 0; i--) {
        let p = allprotos[i];
        let body = lift(p, allprotos, 1);
        let args =[];
        for (let a = 0; a < p.numparams; a++) args.push(`v${a + 1}`);
        if (p.isvararg) args.push("...");
        p.code = `function(${args.join(", ")})\n${body}\nend`;
    }
    return lift(allprotos[mainindex], allprotos, 0);
}
module.exports = { process };
