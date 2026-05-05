const bufferreader = require('./reader');
const opcodes = require('./opcodes');

const layouts = [["instrs", "consts", "protos", "debug"],["consts", "instrs", "protos", "debug"],["consts", "protos", "debug", "instrs"],
    ["instrs", "protos", "debug", "consts"]
];

const aux_opcodes = new Set([
    "GETGLOBAL", "SETGLOBAL", "GETIMPORT", "GETTABLEKS", "SETTABLEKS", "NAMECALL",
    "JUMPIFEQ", "JUMPIFNOTEQ", "JUMPIFLE", "JUMPIFNOTLE", "JUMPIFLT", "JUMPIFNOTLT",
    "FORGPREP", "FORGPREP_INEXT", "FORGPREP_NEXT", "SETLIST", "LOADKX", "JUMPX",
    "JUMPXEQKNIL", "JUMPXEQKB", "JUMPXEQKN", "JUMPXEQKS"
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
        let p_consts = [];
        let p_protos = [];
        let p_locvars =[];
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
                    else if (type === 2) { p_consts.push({ t: 'num', v: r.buffer.readDoubleLE(r.offset) }); r.offset += 8; }
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
                    else throw new Error(`Unknown const type ${type} at idx ${i} (offset: ${r.offset-1})`);
                }
            } else if (block === "protos") {
                let protocount = r.readvarint();
                for (let i = 0; i < protocount; i++) {
                    p_protos.push(r.readvarint());
                }
            } else if (block === "debug") {
                let linedefined = r.readvarint();
                let nameid = r.readvarint();
                p_protoname = nameid > 0 ? strings[nameid - 1] : "anonymous";
                
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

function lift(p, allprotos, indnt) {
    if (!p || !p.instrs) return "";
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
            indnt = Math.max(0, indnt - endScopes[pc].c);
            if (endScopes[pc].t === "else") {
                push("else");
                indnt++;
            } else {
                for(let i = 0; i < endScopes[pc].c; i++) push("end");
            }
        }

        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >>> 8) & 0xFF;
        let b = (raw >>> 16) & 0xFF;
        let c = (raw >>> 24) & 0xFF;
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx - 32768;

        let hasAux = aux_opcodes.has(opname);
        let aux = hasAux ? p.instrs[pc + 1] : 0;
        let auxVal = hasAux ? p.consts[(aux >>> 0) & 0xFFFFFF] : null;

        try {
            if (opname === "LOADNIL") regs[a] = "nil";
            else if (opname === "LOADB") { 
                regs[a] = b === 1 ? "true" : "false"; 
                if (c > 0) pc += c; 
            }
            else if (opname === "LOADN") regs[a] = sbx;
            else if (opname === "LOADK") regs[a] = formatK(p.consts[bx]);
            else if (opname === "LOADKX") regs[a] = formatK(auxVal);
            else if (opname === "MOVE") regs[a] = regs[b] || "nil";
            else if (opname === "GETGLOBAL") regs[a] = formatKVal(auxVal);
            else if (opname === "SETGLOBAL") push(`${formatKVal(auxVal)} = ${regs[a] || "nil"}`);
            else if (opname === "GETIMPORT") regs[a] = formatKVal(auxVal);
            else if (opname === "GETTABLE") regs[a] = `${regs[b] || "nil"}[${regs[c] || "nil"}]`;
            else if (opname === "GETTABLEKS") regs[a] = `${regs[b] || "nil"}.${formatKVal(auxVal)}`;
            else if (opname === "GETTABLEN") regs[a] = `${regs[b] || "nil"}[${c + 1}]`;
            else if (opname === "SETTABLE") push(`${regs[b] || "nil"}[${regs[c] || "nil"}] = ${regs[a] || "nil"}`);
            else if (opname === "SETTABLEKS") push(`${regs[b] || "nil"}.${formatKVal(auxVal)} = ${regs[a] || "nil"}`);
            else if (opname === "SETTABLEN") push(`${regs[b] || "nil"}[${c + 1}] = ${regs[a] || "nil"}`);
            else if (opname === "NAMECALL") {
                regs[a] = { m: true, obj: regs[b] || "nil", func: formatKVal(auxVal) };
                regs[a + 1] = regs[b] || "nil";
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args =[];
                let argcount = b === 0 ? 0 : b - 1;
                let callStr = "";
                if (f && f.m) {
                    for (let i = 2; i <= argcount; i++) args.push(regs[a + i] || "nil");
                    callStr = `${f.obj}:${f.func}(${args.join(", ")})`;
                } else {
                    for (let i = 1; i <= argcount; i++) args.push(regs[a + i] || "nil");
                    callStr = `${typeof f === 'string' ? f : "func"}(${args.join(", ")})`;
                }
                if (c - 1 === 0) push(callStr); else assignVar(a, callStr);
            }
            else if (opname === "RETURN") {
                if (b > 1) {
                    let r =[];
                    for (let i = 0; i < b - 1; i++) r.push(regs[a + i] || "nil");
                    push(`return ${r.join(", ")}`);
                } else if (b === 0) push(`return ...`);
                else push(`return`);
            }
            else if (opname === "JUMP" || opname === "JUMPX") {
                let target = pc + sbx + 1;
                if (sbx < 0) {
                    push("end");
                    indnt = Math.max(0, indnt - 1);
                } else {
                    if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                    endScopes[target].t = "else";
                }
            }
            else if (opname.startsWith("JUMPIF")) {
                let cnd = "";
                if (opname === "JUMPIF") cnd = `not ${regs[a] || "nil"}`;
                else if (opname === "JUMPIFNOT") cnd = regs[a] || "nil";
                else {
                    let left = regs[a] || "nil";
                    let right = regs[aux] || "nil";
                    if (opname === "JUMPIFEQ") cnd = `${left} ~= ${right}`;
                    else if (opname === "JUMPIFNOTEQ") cnd = `${left} == ${right}`;
                    else if (opname === "JUMPIFLE") cnd = `${left} > ${right}`;
                    else if (opname === "JUMPIFNOTLE") cnd = `${left} <= ${right}`;
                    else if (opname === "JUMPIFLT") cnd = `${left} >= ${right}`;
                    else if (opname === "JUMPIFNOTLT") cnd = `${left} < ${right}`;
                }
                push(`if ${cnd} then`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname.startsWith("JUMPXEQ")) {
                let kn = formatK(auxVal);
                let left = regs[a] || "nil";
                let cnd = opname === "JUMPXEQKNIL" ? `${left} ~= nil` :
                          opname === "JUMPXEQKB" ? `${left} ~= true` :
                          `${left} ~= ${kn}`;
                push(`if ${cnd} then`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname === "ADD") regs[a] = `${regs[b] || "nil"} + ${regs[c] || "nil"}`;
            else if (opname === "SUB") regs[a] = `${regs[b] || "nil"} - ${regs[c] || "nil"}`;
            else if (opname === "MUL") regs[a] = `${regs[b] || "nil"} * ${regs[c] || "nil"}`;
            else if (opname === "DIV") regs[a] = `${regs[b] || "nil"} / ${regs[c] || "nil"}`;
            else if (opname === "MOD") regs[a] = `${regs[b] || "nil"} % ${regs[c] || "nil"}`;
            else if (opname === "POW") regs[a] = `${regs[b] || "nil"} ^ ${regs[c] || "nil"}`;
            else if (opname === "ADDK") regs[a] = `${regs[b] || "nil"} + ${formatK(p.consts[c])}`;
            else if (opname === "SUBK") regs[a] = `${regs[b] || "nil"} - ${formatK(p.consts[c])}`;
            else if (opname === "MULK") regs[a] = `${regs[b] || "nil"} * ${formatK(p.consts[c])}`;
            else if (opname === "DIVK") regs[a] = `${regs[b] || "nil"} / ${formatK(p.consts[c])}`;
            else if (opname === "MODK") regs[a] = `${regs[b] || "nil"} % ${formatK(p.consts[c])}`;
            else if (opname === "POWK") regs[a] = `${regs[b] || "nil"} ^ ${formatK(p.consts[c])}`;
            else if (opname === "AND") regs[a] = `${regs[b] || "nil"} and ${regs[c] || "nil"}`;
            else if (opname === "OR") regs[a] = `${regs[b] || "nil"} or ${regs[c] || "nil"}`;
            else if (opname === "ANDK") regs[a] = `${regs[b] || "nil"} and ${formatK(p.consts[c])}`;
            else if (opname === "ORK") regs[a] = `${regs[b] || "nil"} or ${formatK(p.consts[c])}`;
            else if (opname === "NOT") regs[a] = `not ${regs[b] || "nil"}`;
            else if (opname === "MINUS") regs[a] = `-${regs[b] || "nil"}`;
            else if (opname === "LENGTH") regs[a] = `#${regs[b] || "nil"}`;
            else if (opname === "CONCAT") {
                let r =[];
                for (let i = b; i <= c; i++) r.push(regs[i] || '""');
                regs[a] = r.join(" .. ");
            }
            else if (opname === "GETUPVAL") regs[a] = p.upvalues[b] || `upval_${b}`;
            else if (opname === "SETUPVAL") push(`${p.upvalues[b] || `upval_${b}`} = ${regs[a] || "nil"}`);
            else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
                let protoIdx = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
                let code = allprotos[protoIdx] ? allprotos[protoIdx].code : "function() end";
                assignVar(a, code);
            }
            else if (opname === "NEWTABLE" || opname === "DUPTABLE") {
                assignVar(a, "{}");
            }
            else if (opname === "SETLIST") {
                let count = c - 1;
                let startIdx = aux; 
                if (count > 0) {
                    for (let i = 0; i < count; i++) {
                        push(`${regs[a]}[${startIdx + i}] = ${regs[b + i] || "nil"}`);
                    }
                }
            }
            else if (opname === "GETVARARGS") regs[a] = "...";
            else if (opname === "FORNPREP") {
                let loopVar = getVarName(a + 3);
                push(`for ${loopVar} = ${regs[a] || "nil"}, ${regs[a+1] || "nil"}, ${regs[a+2] || "nil"} do`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname.startsWith("FORGPREP")) {
                let var1 = getVarName(a + 3);
                let var2 = getVarName(a + 4);
                push(`for ${var1}, ${var2} in pairs(${regs[a] || "nil"}) do`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
        } catch (e) {}

        pc++;
        if (hasAux) pc++;
    }
    return lines.join("\n");
}

function process(base64str) {
    let buf;
    try {
        buf = Buffer.from(base64str, 'base64');
    } catch (e) {
        return `-- [DECOMPILER CRASH]\n-- Reason: Failed to decode base64 buffer\n-- Message: ${e.message}`;
    }
    
    let r = new bufferreader(buf);
    let trace =[];
    
    let dumpError = (msg) => {
        let err = `-- [DECOMPILER CRASH]\n-- Reason: ${msg}\n-- Buffer Length: ${r.length}\n-- Current Offset: ${r.offset}\n`;
        return err;
    };

    try {
        let version = r.readbyte();
        if (version < 3 || version > 7) return dumpError(`Invalid bytecode version: ${version}`);
        
        if (version >= 4) {
            r.readbyte();
        }
        
        let stringcount = r.readvarint();
        let strings =[];
        for (let i = 0; i < stringcount; i++) {
            let slen = r.readvarint();
            strings.push(r.readstring(slen));
        }
        
        let originalStringsLength = strings.length;
        let savedStringsOffset = r.offset;
        
        let found = false;
        let allprotos =[];
        let mainindex = 0;

        for (let lIdx = 0; lIdx < layouts.length; lIdx++) {
            let layout = layouts[lIdx];
            for (let extraStrings = 0; extraStrings <= 15; extraStrings++) {
                r.offset = savedStringsOffset;
                strings.length = originalStringsLength;
                
                let extraSuccess = true;
                try {
                    for(let k = 0; k < extraStrings; k++) {
                        let slen = r.readvarint();
                        strings.push(r.readstring(slen));
                    }
                } catch(e) {
                    extraSuccess = false;
                }
                if (!extraSuccess) continue;
                
                try {
                    let protocount = r.readvarint();
                    let tempProtos =[];
                    let pSuccess = true;
                    for (let i = 0; i < protocount; i++) {
                        let p = parseproto(r, strings, version, i,[], layout);
                        if (!p.success) {
                            pSuccess = false;
                            break;
                        }
                        tempProtos.push(p);
                    }
                    
                    if (pSuccess) {
                        let mIdx = r.readvarint();
                        if (mIdx >= 0 && mIdx < protocount) {
                            allprotos = tempProtos;
                            mainindex = mIdx;
                            found = true;
                            break;
                        }
                    }
                } catch (e) {}
            }
            if (found) break;
        }

        if (!found) {
            return dumpError(`Missing main proto or format mismatch.`);
        }
        
        for (let i = allprotos.length - 1; i >= 0; i--) {
            let p = allprotos[i];
            let body = lift(p, allprotos, 1);
            let args =[];
            for (let a = 0; a < p.numparams; a++) {
                let name = `v${a + 1}`;
                if (p.locvars) {
                    let loc = p.locvars.find(v => v.reg === a && v.startpc <= 1);
                    if (loc) name = loc.name;
                }
                args.push(name);
            }
            if (p.isvararg) args.push("...");
            p.code = `function(${args.join(", ")})\n${body}\nend`;
        }
        
        return lift(allprotos[mainindex], allprotos, 0);
    } catch (e) {
        return dumpError(`Unexpected fatal trap: ${e.message}`);
    }
}

module.exports = { process };
