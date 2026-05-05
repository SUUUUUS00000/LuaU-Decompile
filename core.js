const bufferreader = require('./reader');
const opcodes = require('./opcodes');

const layouts = [];
const permute = (arr, m = []) => {
    if (arr.length === 0) layouts.push(m);
    else for (let i = 0; i < arr.length; i++) {
        let curr = arr.slice();
        let next = curr.splice(i, 1);
        permute(curr, m.concat(next));
    }
};
permute(["instrs", "consts", "protos", "debug"]);

const aux_opcodes = new Set([
    "GETGLOBAL", "SETGLOBAL", "GETIMPORT", "GETTABLEKS", "SETTABLEKS", "NAMECALL",
    "JUMPIFEQ", "JUMPIFNOTEQ", "JUMPIFLE", "JUMPIFNOTLE", "JUMPIFLT", "JUMPIFNOTLT",
    "JUMPXEQKNIL", "JUMPXEQKB", "JUMPXEQKN", "JUMPXEQKS",
    "FORGLOOP", "LOADKX", "SETLIST", "NEWTABLE", "DUPTABLE", "JUMPX",
    "FASTCALL2", "FASTCALL2K", "FASTCALL3"
]);

function formatKVal(k) {
    if (!k) return "nil";
    if (k.t === 'str') return k.v;
    if (k.t === 'closure') return `closure_${k.id}`;
    if (k.t === 'table') return `{}`;
    if (k.t === 'import') return k.v;
    if (k.t === 'bool') return k.v ? "true" : "false";
    return k.v !== undefined ? k.v : "nil";
}

function formatK(k) {
    if (!k) return "nil";
    if (k.t === 'str') return `"${k.v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    if (k.t === 'bool') return k.v ? "true" : "false";
    if (k.t === 'closure') return `closure_${k.id}`;
    if (k.t === 'table') return `{}`;
    if (k.t === 'import') return k.v;
    return k.v !== undefined ? k.v : "nil";
}

function parseproto(r, strings, version, protoIdx, trace, layout) {
    let startOffset = r.offset;
    try {
        let maxstacksize = r.readbyte();
        let numparams = r.readbyte();
        let numupvalues = r.readbyte();
        let isvararg = r.readbyte();
        
        if (version >= 4) {
            let typeinfoFlags = r.readbyte();
            if (typeinfoFlags > 0) {
                let typesize = r.readvarint();
                r.offset += typesize;
            }
            if (version >= 7) {
                r.readvarint();
                r.readvarint();
            }
        }
        
        let p_instrs =[];
        let p_consts =[];
        let p_protos =[];
        let p_locvars = [];
        let p_upvalues =[];
        let p_protoname = "anonymous";

        for (let block of layout) {
            if (block === "instrs") {
                let instrcount = r.readvarint();
                for (let i = 0; i < instrcount; i++) {
                    p_instrs.push(r.readuint32());
                }
            } else if (block === "consts") {
                let constcount = r.readvarint();
                for (let i = 0; i < constcount; i++) {
                    let type = r.readbyte();
                    if (type === 0) p_consts.push({ t: 'nil', v: 'nil' });
                    else if (type === 1) p_consts.push({ t: 'bool', v: r.readbyte() === 1 });
                    else if (type === 2) { 
                        if (r.offset + 8 > r.length) throw new Error("EOF");
                        p_consts.push({ t: 'num', v: r.buffer.readDoubleLE(r.offset) }); 
                        r.offset += 8; 
                    }
                    else if (type === 3) p_consts.push({ t: 'str', v: strings[r.readvarint() - 1] || "" });
                    else if (type === 4) {
                        let id = r.readuint32();
                        let count = id >>> 30;
                        let arr =[];
                        let getval = (idx) => { 
                            let c = p_consts[idx]; 
                            if (!c) return `unk_${idx}`;
                            if (c.t === 'str') return c.v;
                            return formatKVal(c); 
                        };
                        if (count > 0) arr.push(getval((id >> 20) & 1023));
                        if (count > 1) arr.push(getval((id >> 10) & 1023));
                        if (count > 2) arr.push(getval(id & 1023));
                        p_consts.push({ t: 'import', v: arr.join(".") });
                    }
                    else if (type === 5) {
                        let sz = r.readvarint();
                        for(let j = 0; j < sz; j++) r.readvarint();
                        p_consts.push({ t: 'table', v: '{}' });
                    }
                    else if (type === 6) p_consts.push({ t: 'closure', id: r.readvarint() });
                    else if (type === 7) { r.offset += 16; p_consts.push({ t: 'vector', v: 'Vector3.new()' }); }
                    else throw new Error(`Unknown const type ${type} at idx ${i}`);
                }
            } else if (block === "protos") {
                let protocount = r.readvarint();
                for (let i = 0; i < protocount; i++) {
                    p_protos.push(r.readvarint());
                }
            } else if (block === "debug") {
                let linedefined = r.readvarint();
                let nameid = r.readvarint();
                p_protoname = nameid > 0 ? strings[nameid - 1] || "anonymous" : "anonymous";
                
                let hasLineInfo = r.readbyte();
                if (hasLineInfo !== 0) {
                    let linegap = r.readbyte();
                    let ic = p_instrs.length;
                    let intervals = ic > 0 ? ((ic - 1) >> linegap) + 1 : 0;
                    r.offset += ic + (intervals * 4);
                }
                
                let hasDebugInfo = r.readbyte();
                if (hasDebugInfo !== 0) {
                    let locs = r.readvarint();
                    for (let i = 0; i < locs; i++) {
                        let n_id = r.readvarint();
                        let startpc = r.readvarint();
                        let endpc = r.readvarint();
                        let reg = r.readbyte();
                        p_locvars.push({ name: strings[n_id - 1] || "v" + reg, startpc, endpc, reg });
                    }
                    let upvs = r.readvarint();
                    for (let i = 0; i < upvs; i++) {
                        let n_id = r.readvarint();
                        p_upvalues.push(strings[n_id - 1] || "upval_" + i);
                    }
                }
            }
        }
        
        return { 
            numparams, 
            isvararg, 
            instrs: p_instrs, 
            consts: p_consts, 
            protos: p_protos, 
            protoname: p_protoname, 
            locvars: p_locvars, 
            upvalues: p_upvalues, 
            success: true, 
            parsed: r.offset - startOffset 
        };
    } catch (e) {
        return { success: false, error: e.message, offset: r.offset };
    }
}

function lift(p, allprotos, indnt, getProtoCode) {
    if (!p || !p.instrs || p.instrs.length === 0) return "";
    let lines =[];
    let regs = new Array(256).fill("nil");
    let definedVars = new Set();
    let pc = 0;
    let endScopes = {};
    
    let getVarName = (reg) => {
        if (p.locvars) {
            let loc = p.locvars.find(v => v.reg === reg && v.startpc <= pc && v.endpc >= pc);
            if (loc) return loc.name;
        }
        return `v${reg}`;
    };

    let push = (str) => { lines.push("    ".repeat(indnt) + str); };

    let assignVar = (reg, val) => {
        let varName = getVarName(reg);
        if (definedVars.has(varName)) {
            push(`${varName} = ${val}`);
        } else {
            definedVars.add(varName);
            push(`local ${varName} = ${val}`);
        }
        regs[reg] = varName;
    };

    while (pc < p.instrs.length) {
        if (endScopes[pc]) {
            for (let i = 0; i < endScopes[pc].c; i++) {
                indnt = Math.max(0, indnt - 1);
                if (endScopes[pc].t === "else") {
                    push("else");
                    indnt++;
                } else {
                    push("end");
                }
            }
        }

        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >>> 8) & 0xFF;
        let b = (raw >>> 16) & 0xFF;
        let c = (raw >>> 24) & 0xFF;
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = raw >> 16;

        let hasAux = aux_opcodes.has(opname);
        let aux = hasAux ? (p.instrs[pc + 1] || 0) : 0;
        let auxVal = hasAux ? p.consts[(aux >>> 0) & 0xFFFFFF] : null;

        try {
            if (opname === "LOADNIL") regs[a] = "nil";
            else if (opname === "LOADB") { 
                regs[a] = b === 1 ? "true" : "false"; 
                if (c > 0) pc += c;
            }
            else if (opname === "LOADN") regs[a] = sbx.toString();
            else if (opname === "LOADK") regs[a] = formatK(p.consts[bx]);
            else if (opname === "LOADKX") regs[a] = formatK(auxVal);
            else if (opname === "MOVE") regs[a] = regs[b] || getVarName(b);
            else if (opname === "GETGLOBAL") regs[a] = formatKVal(auxVal);
            else if (opname === "SETGLOBAL") push(`${formatKVal(auxVal)} = ${regs[a] || getVarName(a)}`);
            else if (opname === "GETIMPORT") regs[a] = formatKVal(auxVal);
            else if (opname === "GETTABLE") regs[a] = `${regs[b] || getVarName(b)}[${regs[c] || getVarName(c)}]`;
            else if (opname === "SETTABLE") push(`${regs[b] || getVarName(b)}[${regs[c] || getVarName(c)}] = ${regs[a] || getVarName(a)}`);
            else if (opname === "GETTABLEKS") regs[a] = `${regs[b] || getVarName(b)}.${formatKVal(auxVal)}`;
            else if (opname === "SETTABLEKS") push(`${regs[b] || getVarName(b)}.${formatKVal(auxVal)} = ${regs[a] || getVarName(a)}`);
            else if (opname === "NAMECALL") {
                regs[a] = { m: true, obj: regs[b] || getVarName(b), func: formatKVal(auxVal) };
                regs[a + 1] = regs[b] || getVarName(b);
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args = [];
                let callStr = "";
                let argcount = b === 0 ? 0 : b - 1;
                if (f && typeof f === "object" && f.m) {
                    for (let i = 2; i <= argcount; i++) args.push(regs[a + i] || getVarName(a + i));
                    callStr = `${f.obj}:${f.func}(${args.join(", ")})`;
                } else {
                    for (let i = 1; i <= argcount; i++) args.push(regs[a + i] || getVarName(a + i));
                    callStr = `${f || getVarName(a)}(${args.join(", ")})`;
                }
                if (c - 1 === 0) push(callStr); else assignVar(a, callStr);
            }
            else if (opname === "RETURN") {
                if (b > 1) {
                    let r = [];
                    for (let i = 0; i < b - 1; i++) r.push(regs[a + i] || getVarName(a + i));
                    push(`return ${r.join(", ")}`);
                } else if (b === 0) push(`return ...`);
                else push(`return`);
            }
            else if (opname === "JUMP") {
                let target = pc + sbx + 1;
                if (sbx > 0) {
                    if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                    endScopes[target].t = "else";
                    endScopes[target].c++;
                    push("else");
                    indnt++;
                }
            }
            else if (opname.startsWith("JUMPIF")) {
                let cond = "";
                let left = regs[a] || getVarName(a);
                let right = regs[aux & 0xFF] || getVarName(aux & 0xFF);
                if (opname === "JUMPIF") cond = left;
                else if (opname === "JUMPIFNOT") cond = `not ${left}`;
                else if (opname === "JUMPIFEQ") cond = `${left} == ${right}`;
                else if (opname === "JUMPIFNOTEQ") cond = `${left} ~= ${right}`;
                else if (opname === "JUMPIFLE") cond = `${left} <= ${right}`;
                else if (opname === "JUMPIFNOTLE") cond = `${left} > ${right}`;
                else if (opname === "JUMPIFLT") cond = `${left} < ${right}`;
                else if (opname === "JUMPIFNOTLT") cond = `${left} >= ${right}`;
                push(`if ${cond} then`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname === "ADD") regs[a] = `${regs[b] || getVarName(b)} + ${regs[c] || getVarName(c)}`;
            else if (opname === "SUB") regs[a] = `${regs[b] || getVarName(b)} - ${regs[c] || getVarName(c)}`;
            else if (opname === "MUL") regs[a] = `${regs[b] || getVarName(b)} * ${regs[c] || getVarName(c)}`;
            else if (opname === "DIV") regs[a] = `${regs[b] || getVarName(b)} / ${regs[c] || getVarName(c)}`;
            else if (opname === "MOD") regs[a] = `${regs[b] || getVarName(b)} % ${regs[c] || getVarName(c)}`;
            else if (opname === "ADDK") regs[a] = `${regs[b] || getVarName(b)} + ${formatK(p.consts[c])}`;
            else if (opname === "SUBK") regs[a] = `${regs[b] || getVarName(b)} - ${formatK(p.consts[c])}`;
            else if (opname === "MULK") regs[a] = `${regs[b] || getVarName(b)} * ${formatK(p.consts[c])}`;
            else if (opname === "DIVK") regs[a] = `${regs[b] || getVarName(b)} / ${formatK(p.consts[c])}`;
            else if (opname === "CONCAT") {
                let r = [];
                for (let i = b; i <= c; i++) r.push(regs[i] || getVarName(i));
                regs[a] = r.join(" .. ");
            }
            else if (opname === "GETUPVAL") regs[a] = p.upvalues[b] || `upval_${b}`;
            else if (opname === "SETUPVAL") push(`${p.upvalues[b] || `upval_${b}`} = ${regs[a] || getVarName(a)}`);
            else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
                let id = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
                assignVar(a, getProtoCode(id, indnt));
            }
            else if (opname === "NEWTABLE") assignVar(a, "{}");
            else if (opname === "FORNPREP") {
                push(`for ${getVarName(a + 2)} = ${regs[a] || getVarName(a)}, ${regs[a + 1] || getVarName(a + 1)} do`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname === "JUMPBACK") {
                indnt = Math.max(0, indnt - 1);
                push("end");
            }
        } catch (e) {}
        pc++;
        if (hasAux) pc++;
    }
    return lines.join("\n");
}

function process(base64str) {
    try {
        let buf = Buffer.from(base64str, 'base64');
        let r = new bufferreader(buf);
        let ob = r.readbyte;
        r.readbyte = function() {
            if (this.offset >= this.length) throw new Error("EOF");
            return ob.call(this);
        };
        let version = r.readbyte();
        if (version >= 4) r.readbyte();
        let stringcount = r.readvarint();
        let strings = [];
        for (let i = 0; i < stringcount; i++) strings.push(r.readstring(r.readvarint()));
        let protocount = r.readvarint();
        let allprotos = [];
        for (let i = 0; i < protocount; i++) {
            let res = parseproto(r, strings, version, i, [], layouts[0]);
            allprotos.push(res);
        }
        let mainindex = r.readvarint();
        let getProtoCode = (idx, ind) => {
            let cp = allprotos[idx];
            if (!cp || cp.code) return cp ? cp.code : "function() end";
            let args = [];
            for (let i = 0; i < cp.numparams; i++) {
                let loc = cp.locvars.find(v => v.reg === i && v.startpc <= 1);
                args.push(loc ? loc.name : `p${i+1}`);
            }
            if (cp.isvararg) args.push("...");
            cp.code = "function() end";
            let body = lift(cp, allprotos, ind + 1, getProtoCode);
            cp.code = `function(${args.join(", ")})\n${body}\n${"    ".repeat(ind)}end`;
            return cp.code;
        };
        return lift(allprotos[mainindex], allprotos, 0, getProtoCode);
    } catch (e) { return `-- [FATAL] ${e.message}`; }
}

module.exports = { process };
