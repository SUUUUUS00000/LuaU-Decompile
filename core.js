const bufferreader = require('./reader');
const opcodes = require('./opcodes');

const layouts = [];
const permute = (arr, m =[]) => {
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
    "FASTCALL1", "FASTCALL2", "FASTCALL2K", "FASTCALL3"
]);

function formatKVal(k) {
    if (!k) return "nil";
    if (k.t === 'str') return k.v;
    if (k.t === 'closure') return `closure_${k.id}`;
    if (k.t === 'table') return `{}`;
    if (k.t === 'import') return k.v;
    if (k.t === 'bool') return k.v ? "true" : "false";
    if (k.t === 'num') return k.v;
    return k.v !== undefined ? k.v : "nil";
}

function formatK(k) {
    if (!k) return "nil";
    if (k.t === 'str') return `"${k.v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
    if (k.t === 'bool') return k.v ? "true" : "false";
    if (k.t === 'closure') return `closure_${k.id}`;
    if (k.t === 'table') return `{}`;
    if (k.t === 'import') return k.v;
    if (k.t === 'num') return k.v;
    return k.v !== undefined ? k.v : "nil";
}

function parseproto(r, strings, version, protoIdx, trace, layout, useTypeInfo, useUpvalueNames) {
    let startOffset = r.offset;
    try {
        let maxstacksize = r.readbyte();
        let numparams = r.readbyte();
        let numupvalues = r.readbyte();
        let isvararg = r.readbyte();
        
        if (useTypeInfo && version >= 4) {
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
                    if (useUpvalueNames) {
                        let upvs = r.readvarint();
                        for (let i = 0; i < upvs; i++) {
                            let n_id = r.readvarint();
                            p_upvalues.push(strings[n_id - 1] || "upval_" + i);
                        }
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
    let lines = [];
    let regs = new Array(256).fill(null);
    let definedVars = new Set();
    let pc = 0;
    let endScopes = {};
    let loopStarts = new Set();

    let getVarName = (reg) => {
        if (p.locvars) {
            let loc = p.locvars.find(v => v.reg === reg && v.startpc <= pc && v.endpc >= pc);
            if (loc) return loc.name;
        }
        return `v${reg}`;
    };

    for (let i = 0; i < p.numparams; i++) {
        let name = getVarName(i);
        regs[i] = name;
        definedVars.add(name);
    }

    let push = (str) => { lines.push("    ".repeat(indnt) + str); };

    let getR = (r) => {
        return regs[r] !== null ? regs[r] : getVarName(r);
    };

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
            if (endScopes[pc].t === "else") {
                indnt = Math.max(0, indnt - 1);
                push("else");
                indnt++;
            } else if (endScopes[pc].c > 0) {
                indnt = Math.max(0, indnt - endScopes[pc].c);
                for(let i = 0; i < endScopes[pc].c; i++) push("end");
            }
        }

        if (loopStarts.has(pc)) {
            push("while true do");
            indnt++;
        }

        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >>> 8) & 0xFF;
        let b = (raw >>> 16) & 0xFF;
        let c = (raw >>> 24) & 0xFF;
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx;
        if (sbx >= 32768) sbx -= 65536;

        let hasAux = aux_opcodes.has(opname);
        let aux = hasAux ? (p.instrs[pc + 1] || 0) : 0;
        let auxVal = hasAux ? p.consts[(aux >>> 0) & 0xFFFFFF] : null;

        if (opname === "NOP" || opname === "COVERAGE" || opname === "CAPTURE" || opname === "PREPVARARGS") {
            pc += hasAux ? 2 : 1;
            continue;
        }

        try {
            if (opname === "LOADNIL") regs[a] = "nil";
            else if (opname === "LOADB") { 
                regs[a] = b === 1 ? "true" : "false"; 
                if (c > 0) {
                    let target = pc + c + 1;
                    if (endScopes[pc + 1] && endScopes[pc + 1].t !== "else") {
                        let moveCount = endScopes[pc + 1].c;
                        endScopes[pc + 1].t = "else";
                        endScopes[pc + 1].c = 0;
                        if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                        endScopes[target].c += moveCount;
                    }
                }
            }
            else if (opname === "LOADN") regs[a] = sbx;
            else if (opname === "LOADK") regs[a] = formatK(p.consts[bx]);
            else if (opname === "LOADKX") regs[a] = formatK(auxVal);
            else if (opname === "MOVE") regs[a] = getR(b);
            else if (opname === "GETGLOBAL") regs[a] = formatKVal(auxVal);
            else if (opname === "SETGLOBAL") push(`${formatKVal(auxVal)} = ${getR(a)}`);
            else if (opname === "GETIMPORT") regs[a] = formatKVal(auxVal);
            else if (opname === "GETTABLE") regs[a] = `${getR(b)}[${getR(c)}]`;
            else if (opname === "GETTABLEKS") regs[a] = `${getR(b)}.${formatKVal(auxVal)}`;
            else if (opname === "GETTABLEN") regs[a] = `${getR(b)}[${c + 1}]`;
            else if (opname === "SETTABLE") push(`${getR(b)}[${getR(c)}] = ${getR(a)}`);
            else if (opname === "SETTABLEKS") push(`${getR(b)}.${formatKVal(auxVal)} = ${getR(a)}`);
            else if (opname === "SETTABLEN") push(`${getR(b)}[${c + 1}] = ${getR(a)}`);
            else if (opname === "NAMECALL") {
                regs[a] = { m: true, obj: getR(b), func: formatKVal(auxVal) };
                regs[a + 1] = getR(b);
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args = [];
                let callStr = "";
                if (b === 0) {
                    args.push("...");
                } else {
                    let argcount = b - 1;
                    if (f && f.m) {
                        for (let i = 2; i <= argcount; i++) args.push(getR(a + i));
                    } else {
                        for (let i = 1; i <= argcount; i++) args.push(getR(a + i));
                    }
                }
                if (f && f.m) callStr = `${f.obj}:${f.func}(${args.join(", ")})`;
                else callStr = `${typeof f === 'string' ? f : getVarName(a)}(${args.join(", ")})`;
                if (c - 1 === 0) push(callStr); else assignVar(a, callStr);
            }
            else if (opname === "RETURN") {
                if (b > 1) {
                    let r = [];
                    for (let i = 0; i < b - 1; i++) r.push(getR(a + i));
                    push(`return ${r.join(", ")}`);
                } else if (b === 0) push(`return ...`);
                else push(`return`);
            }
            else if (opname === "JUMP" || opname === "JUMPX") {
                let offset = opname === "JUMPX" ? (raw >> 8) : sbx;
                let target = pc + offset + 1;
                if (offset > 0) {
                    if (endScopes[pc + 1] && endScopes[pc + 1].t !== "else") {
                        let crossed = false;
                        for (let i = pc + 2; i <= target; i++) {
                            if (endScopes[i]) { crossed = true; break; }
                        }
                        if (!crossed) {
                            let moveCount = endScopes[pc + 1].c;
                            endScopes[pc + 1].t = "else";
                            endScopes[pc + 1].c = 0;
                            if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                            endScopes[target].c += moveCount;
                        } else {
                            push("break");
                        }
                    } else {
                        push("break");
                    }
                }
            }
            else if (opname === "JUMPBACK") {
                let offset = -bx;
                let target = pc + offset + 1;
                loopStarts.add(target);
                if (!endScopes[pc + 1]) endScopes[pc + 1] = { c: 0, t: "end" };
                endScopes[pc + 1].c++;
            }
            else if (opname.startsWith("JUMPIF") || opname.startsWith("JUMPXEQ")) {
                let fwd = sbx >= 0;
                let cnd = "";
                let left = getR(a);
                
                if (opname.startsWith("JUMPXEQ")) {
                    let offset = aux | 0;
                    fwd = offset >= 0;
                    let kn = p.consts[bx] ? formatK(p.consts[bx]) : "unk";
                    if (opname === "JUMPXEQKNIL") cnd = fwd ? `${left} ~= nil` : `${left} == nil`;
                    else if (opname === "JUMPXEQKB") {
                        let kb = ((raw >>> 16) & 0xFF) === 1 ? "true" : "false";
                        cnd = fwd ? `${left} ~= ${kb}` : `${left} == ${kb}`;
                    }
                    else cnd = fwd ? `${left} ~= ${kn}` : `${left} == ${kn}`;
                    sbx = offset;
                } else {
                    let right = getR(aux & 0xFF);
                    if (opname === "JUMPIF") cnd = fwd ? `not ${left}` : left;
                    else if (opname === "JUMPIFNOT") cnd = fwd ? left : `not ${left}`;
                    else if (opname === "JUMPIFEQ") cnd = fwd ? `${left} ~= ${right}` : `${left} == ${right}`;
                    else if (opname === "JUMPIFNOTEQ") cnd = fwd ? `${left} == ${right}` : `${left} ~= ${right}`;
                    else if (opname === "JUMPIFLE") cnd = fwd ? `${left} > ${right}` : `${left} <= ${right}`;
                    else if (opname === "JUMPIFNOTLE") cnd = fwd ? `${left} <= ${right}` : `${left} > ${right}`;
                    else if (opname === "JUMPIFLT") cnd = fwd ? `${left} >= ${right}` : `${left} < ${right}`;
                    else if (opname === "JUMPIFNOTLT") cnd = fwd ? `${left} < ${right}` : `${left} >= ${right}`;
                }

                let target = pc + sbx + 1;
                if (!fwd) {
                    push(`if ${cnd} then break end`);
                } else {
                    push(`if ${cnd} then`);
                    if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                    endScopes[target].c++;
                    indnt++;
                }
            }
            else if (opname === "ADD") regs[a] = `${getR(b)} + ${getR(c)}`;
            else if (opname === "SUB") regs[a] = `${getR(b)} - ${getR(c)}`;
            else if (opname === "MUL") regs[a] = `${getR(b)} * ${getR(c)}`;
            else if (opname === "DIV") regs[a] = `${getR(b)} / ${getR(c)}`;
            else if (opname === "MOD") regs[a] = `${getR(b)} % ${getR(c)}`;
            else if (opname === "POW") regs[a] = `${getR(b)} ^ ${getR(c)}`;
            else if (opname === "ADDK") regs[a] = `${getR(b)} + ${formatK(p.consts[c])}`;
            else if (opname === "SUBK") regs[a] = `${getR(b)} - ${formatK(p.consts[c])}`;
            else if (opname === "MULK") regs[a] = `${getR(b)} * ${formatK(p.consts[c])}`;
            else if (opname === "DIVK") regs[a] = `${getR(b)} / ${formatK(p.consts[c])}`;
            else if (opname === "MODK") regs[a] = `${getR(b)} % ${formatK(p.consts[c])}`;
            else if (opname === "POWK") regs[a] = `${getR(b)} ^ ${formatK(p.consts[c])}`;
            else if (opname === "SUBRK") regs[a] = `${formatK(p.consts[b])} - ${getR(c)}`;
            else if (opname === "DIVRK") regs[a] = `${formatK(p.consts[b])} / ${getR(c)}`;
            else if (opname === "IDIV") regs[a] = `math.floor(${getR(b)} / ${getR(c)})`;
            else if (opname === "IDIVK") regs[a] = `math.floor(${getR(b)} / ${formatK(p.consts[c])})`;
            else if (opname === "AND") regs[a] = `${getR(b)} and ${getR(c)}`;
            else if (opname === "OR") regs[a] = `${getR(b)} or ${getR(c)}`;
            else if (opname === "ANDK") regs[a] = `${getR(b)} and ${formatK(p.consts[c])}`;
            else if (opname === "ORK") regs[a] = `${getR(b)} or ${formatK(p.consts[c])}`;
            else if (opname === "NOT") regs[a] = `not ${getR(b)}`;
            else if (opname === "MINUS") regs[a] = `-${getR(b)}`;
            else if (opname === "LENGTH") regs[a] = `#${getR(b)}`;
            else if (opname === "CONCAT") {
                let r = [];
                for (let i = b; i <= c; i++) r.push(getR(i));
                regs[a] = r.join(" .. ");
            }
            else if (opname === "GETUPVAL") regs[a] = p.upvalues[b] || `upval_${b}`;
            else if (opname === "SETUPVAL") push(`${p.upvalues[b] || `upval_${b}`} = ${getR(a)}`);
            else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
                let protoIdx = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
                assignVar(a, getProtoCode(protoIdx, indnt));
            }
            else if (opname === "NEWTABLE" || opname === "DUPTABLE") {
                assignVar(a, "{}");
            }
            else if (opname === "SETLIST") {
                let count = c - 1;
                let startIdx = aux; 
                if (count > 0) {
                    for (let i = 0; i < count; i++) {
                        push(`${getR(a)}[${startIdx + i}] = ${getR(b + i)}`);
                    }
                }
            }
            else if (opname === "GETVARARGS") regs[a] = "...";
            else if (opname === "FORNPREP") {
                let loopVar = getVarName(a + 2);
                push(`for ${loopVar} = ${getR(a)} or 0, ${getR(a+1)} or 0, ${getR(a+2)} or 1 do`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname === "FORNLOOP") {
            }
            else if (opname.startsWith("FORGPREP")) {
                let var1 = getVarName(a + 3);
                let var2 = getVarName(a + 4);
                push(`for ${var1}, ${var2} in pairs(${getR(a)}) do`);
                let target = pc + sbx + 1;
                if (!endScopes[target]) endScopes[target] = { c: 0, t: "end" };
                endScopes[target].c++;
                indnt++;
            }
            else if (opname === "BREAK") {
                push("break");
            }
            else if (opname === "CLOSEUPVALS") {
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
        let ou = r.readuint32;
        r.readuint32 = function() {
            if (this.offset + 4 > this.length) throw new Error("EOF");
            return ou.call(this);
        };
        let os = r.readstring;
        r.readstring = function(len) {
            if (this.offset + len > this.length) throw new Error("EOF");
            return os.call(this, len);
        };

        let version = r.readbyte();
        if (version < 3 || version > 7) return "";
        
        let savedGlobalOffset = r.offset;
        let globalActionFlagOptions = (version >= 4) ? [true, false] : [false];
        
        let structuralOptions = [
            { typeinfo: false, upvalues: false },
            { typeinfo: false, upvalues: true },
            { typeinfo: true,  upvalues: false },
            { typeinfo: true,  upvalues: true }
        ];

        let found = false;
        let allprotos =[];
        let mainindex = 0;

        for (let useGlobalActionFlag of globalActionFlagOptions) {
            r.offset = savedGlobalOffset;
            if (useGlobalActionFlag) r.readbyte();

            try {
                let stringcount = r.readvarint();
                if (stringcount > 100000) continue; 

                let strings =[];
                for (let i = 0; i < stringcount; i++) {
                    let slen = r.readvarint();
                    strings.push(r.readstring(slen));
                }
                
                let originalStringsLength = strings.length;
                let savedStringsOffset = r.offset;

                for (let lIdx = 0; lIdx < layouts.length; lIdx++) {
                    let layout = layouts[lIdx];
                    for (let opt of structuralOptions) {
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
                                    let p = parseproto(r, strings, version, i, [], layout, opt.typeinfo, opt.upvalues);
                                    if (!p.success) {
                                        pSuccess = false;
                                        break;
                                    }
                                    tempProtos.push(p);
                                }
                                
                                if (pSuccess) {
                                    let mIdx = r.readvarint();
                                    if (mIdx >= 0 && mIdx < protocount && tempProtos[mIdx] && tempProtos[mIdx].instrs.length > 0) {
                                        let firstOp = tempProtos[mIdx].instrs[0] & 0xFF;
                                        if (opcodes[firstOp] && !opcodes[firstOp].includes("UNKNOWN")) {
                                            allprotos = tempProtos;
                                            mainindex = mIdx;
                                            found = true;
                                            break;
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                        if (found) break;
                    }
                    if (found) break;
                }
            } catch (e) {}
            if (found) break;
        }

        if (!found) {
            return "-- [DECOMPILER ERROR] Invalid main proto index or failed to determine bytecode structure.";
        }
        
        let activeProtos = new Set();
        let getProtoCode = (pIdx, indnt) => {
            let cp = allprotos[pIdx];
            if (!cp) return "function() end";
            if (activeProtos.has(pIdx)) return `function() end`;
            if (cp.code) return cp.code;
            
            activeProtos.add(pIdx);
            
            cp.code = "function() end";
            let args =[];
            for (let a = 0; a < cp.numparams; a++) {
                let name = `v${a + 1}`;
                if (cp.locvars) {
                    let loc = cp.locvars.find(v => v.reg === a && v.startpc <= 1);
                    if (loc) name = loc.name;
                }
                args.push(name);
            }
            if (cp.isvararg) args.push("...");
            
            let body = lift(cp, allprotos, indnt + 1, getProtoCode);
            let indntStr = "    ".repeat(indnt);
            cp.code = `function(${args.join(", ")})\n${body}\n${indntStr}end`;
            
            activeProtos.delete(pIdx);
            return cp.code;
        };
        
        let finalCode = lift(allprotos[mainindex], allprotos, 0, getProtoCode);
        return finalCode.length > 0 ? finalCode : "";

    } catch (e) {
        return "";
    }
}

module.exports = { process };
