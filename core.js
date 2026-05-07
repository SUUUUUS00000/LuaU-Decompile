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
    if (!k) return { type: "Literal", value: "nil" };
    if (k.t === 'str') return { type: "Literal", value: `"${k.v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"` };
    if (k.t === 'bool') return { type: "Literal", value: k.v ? "true" : "false" };
    if (k.t === 'closure') return { type: "Literal", value: `closure_${k.id}` };
    if (k.t === 'table') return { type: "Table", entries: [] };
    if (k.t === 'import') return { type: "Identifier", name: k.v };
    if (k.t === 'num') return { type: "Literal", value: k.v };
    return { type: "Literal", value: k.v !== undefined ? k.v : "nil" };
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
        
        let p_instrs = [];
        let p_consts = [];
        let p_protos = [];
        let p_locvars = [];
        let p_upvalues = [];
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
                        let arr = [];
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

function optimizeAST(node) {
    if (!node) return node;
    
    if (node.type === "Block") {
        for (let i = 0; i < node.body.length; i++) {
            node.body[i] = optimizeAST(node.body[i]);
        }
        node.body = node.body.filter(n => n !== null);
    } else if (node.type === "If") {
        node.body = optimizeAST(node.body);
        if (node.elseBody) node.elseBody = optimizeAST(node.elseBody);
        
        if (!node.elseBody && node.body && node.body.body && node.body.body.length === 1) {
            let inner = node.body.body[0];
            if (inner.type === "If" && !inner.elseBody) {
                node.cond = { type: "BinaryExpression", op: "and", left: node.cond, right: inner.cond };
                node.body = inner.body;
                return optimizeAST(node); 
            }
        }

        if (node.elseBody && node.body && node.body.body.length === 1 && node.elseBody.body.length === 1) {
            let tStmt = node.body.body[0];
            let eStmt = node.elseBody.body[0];
            if ((tStmt.type === "Assignment" && eStmt.type === "Assignment") || 
                (tStmt.type === "LocalAssignment" && eStmt.type === "LocalAssignment")) {
                if (stringifyAST(tStmt.left, 0) === stringifyAST(eStmt.left, 0)) {
                    return {
                        type: tStmt.type,
                        left: tStmt.left,
                        right: {
                            type: "BinaryExpression", op: "or",
                            left: { type: "BinaryExpression", op: "and", left: node.cond, right: tStmt.right },
                            right: eStmt.right
                        }
                    };
                }
            }
        }
    } else if (node.type === "While") {
        node.body = optimizeAST(node.body);
        if (node.cond && node.cond.value === "true" && node.body && node.body.body) {
            let stmts = node.body.body;
            if (stmts.length > 0) {
                let lastStmt = stmts[stmts.length - 1];
                if (lastStmt.type === "If" && !lastStmt.elseBody && lastStmt.body && lastStmt.body.body.length === 1 && lastStmt.body.body[0].type === "Break") {
                    node.type = "Repeat";
                    node.cond = lastStmt.cond; 
                    stmts.pop(); 
                }
            }
        }
    } else if (node.type === "For" || node.type === "ForIn" || node.type === "Function") {
        node.body = optimizeAST(node.body);
    } else if (node.type === "LocalAssignment" || node.type === "Assignment") {
        if (node.right && node.right.type === "Function") {
            node.right.body = optimizeAST(node.right.body);
        }
    }
    
    return node;
}

function stringifyAST(node, ind) {
    if (!node) return "";
    let p = "    ".repeat(ind);
    if (typeof node === 'string') return node;
    switch (node.type) {
        case "Block": return node.body.map(n => stringifyAST(n, ind)).filter(x => x).join("\n");
        case "Assignment": 
            if (node.right && node.right.type === "Function") {
                return `${p}function ${stringifyAST(node.left, 0)}(${node.right.args.join(", ")})\n${stringifyAST(node.right.body, ind+1)}\n${p}end`;
            }
            return `${p}${stringifyAST(node.left, 0)} = ${stringifyAST(node.right, ind)}`;
        case "LocalAssignment":
            if (node.right && node.right.type === "Function") {
                return `${p}local function ${stringifyAST(node.left, 0)}(${node.right.args.join(", ")})\n${stringifyAST(node.right.body, ind+1)}\n${p}end`;
            }
            return `${p}local ${stringifyAST(node.left, 0)} = ${stringifyAST(node.right, ind)}`;
        case "MultiAssignment": return `${p}local ${node.left.map(x => stringifyAST(x,0)).join(", ")} = ${stringifyAST(node.right, ind)}`;
        case "CallStatement": return `${p}${stringifyAST(node.call, ind)}`;
        case "Call": {
            let funcStr = stringifyAST(node.func, ind);
            if (node.func && node.func.type === "Function") {
                funcStr = `(${funcStr})`;
            }
            return node.isMethod ? `${stringifyAST(node.func.obj, 0)}:${node.func.func}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})` : `${funcStr}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})`;
        }
        case "Return": return `${p}return ${node.args.map(a => stringifyAST(a, 0)).join(", ")}`;
        case "If": 
            let out = `${p}if ${stringifyAST(node.cond, 0)} then\n${stringifyAST(node.body, ind+1)}`;
            let currElse = node.elseBody;
            while (currElse && currElse.body && currElse.body.length === 1 && currElse.body[0].type === "If") {
                let nextIf = currElse.body[0];
                out += `\n${p}elseif ${stringifyAST(nextIf.cond, 0)} then\n${stringifyAST(nextIf.body, ind+1)}`;
                currElse = nextIf.elseBody;
            }
            if (currElse && currElse.body && currElse.body.length > 0) {
                out += `\n${p}else\n${stringifyAST(currElse, ind+1)}`;
            }
            out += `\n${p}end`;
            return out;
        case "While": return `${p}while ${stringifyAST(node.cond, 0)} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "Repeat": return `${p}repeat\n${stringifyAST(node.body, ind+1)}\n${p}until ${stringifyAST(node.cond, 0)}`;
        case "For": return `${p}for ${node.vars} = ${stringifyAST(node.start, 0)}, ${stringifyAST(node.end, 0)}${node.step ? ", " + stringifyAST(node.step, 0) : ""} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "ForIn": 
            let iterStr = node.iterFunc ? `${node.iterFunc}(${stringifyAST(node.iters, 0)})` : stringifyAST(node.iters, 0);
            return `${p}for ${node.vars.join(", ")} in ${iterStr} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "Break": return `${p}break`;
        case "Index": return `${stringifyAST(node.obj, 0)}[${stringifyAST(node.prop, 0)}]`;
        case "IndexProp": return `${stringifyAST(node.obj, 0)}.${node.prop}`;
        case "Table": 
            if (node.entries && node.entries.length > 0) {
                let props = node.entries.map(e => {
                    let valStr = stringifyAST(e.value, ind+1);
                    return e.isBracket ? `[${stringifyAST(e.key, 0)}] = ${valStr}` : `${e.key} = ${valStr}`;
                });
                return `{\n${p}    ${props.join(`,\n${p}    `)}\n${p}}`;
            }
            return `{}`;
        case "Identifier": return node.name;
        case "Literal": return node.value;
        case "BinaryExpression": return `${stringifyAST(node.left, 0)} ${node.op} ${stringifyAST(node.right, 0)}`;
        case "UnaryExpression": return `${node.op}${node.op === "not" ? " " : ""}${stringifyAST(node.arg, 0)}`;
        case "Function": return `function(${node.args.join(", ")})\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "Vararg": return "...";
        case "Group": return `(${stringifyAST(node.exp, 0)})`;
    }
    return "";
}

function lift(p, allprotos, getProtoCode) {
    if (!p || !p.instrs || p.instrs.length === 0) return { type: "Block", body: [] };

    let definedVars = new Set();
    let namecalls = {};
    let regs = new Array(256).fill(null);

    let getInstrSize = (pc) => {
        let op = p.instrs[pc] & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        return aux_opcodes.has(opname) ? 2 : 1;
    };

    let loopStarts = {};
    for (let i = 0; i < p.instrs.length; ) {
        let op = p.instrs[i] & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let bx = (p.instrs[i] >>> 16) & 0xFFFF;
        let sbx = bx >= 32768 ? bx - 65536 : bx;
        
        if (opname === "JUMPBACK") {
            let targetPc = i - bx + 1;
            loopStarts[targetPc] = { tailPc: i, type: opname };
        }
        i += getInstrSize(i);
    }

    let getNamedLocal = (reg, currentPc) => {
        if (p.locvars) {
            let loc = p.locvars.find(v => v.reg === reg && v.startpc <= currentPc + 1 && v.endpc >= currentPc);
            if (loc) return loc.name;
        }
        return null;
    };

    for (let i = 0; i < p.numparams; i++) {
        let name = getNamedLocal(i, 0) || `v${i}`;
        definedVars.add(name);
        regs[i] = { type: "Identifier", name: name };
    }

    let getR = (r, currentPc) => regs[r] || { type: "Identifier", name: getNamedLocal(r, currentPc) || `v${r}` };

    function parseBlock(startPc, endPc) {
        let body = [];
        let pc = startPc;

        let handleRegAssign = (reg, node, forceEmit = false) => {
            let name = getNamedLocal(reg, pc);
            if (name || forceEmit) {
                let vName = name || `v${reg}`;
                let idNode = { type: "Identifier", name: vName };
                let assignNode;
                if (!definedVars.has(vName)) {
                    definedVars.add(vName);
                    assignNode = { type: "LocalAssignment", left: idNode, right: node };
                } else {
                    assignNode = { type: "Assignment", left: idNode, right: node };
                }
                regs[reg] = idNode;
                return assignNode;
            } else {
                regs[reg] = node;
                return null;
            }
        };

        while (pc < endPc) {
            if (loopStarts[pc] && pc < loopStarts[pc].tailPc) {
                let tailPc = loopStarts[pc].tailPc;
                let loopBody = parseBlock(pc, tailPc);
                body.push({ type: "While", cond: {type: "Literal", value: "true"}, body: {type: "Block", body: loopBody} });
                pc = tailPc + getInstrSize(tailPc);
                continue;
            }

            let raw = p.instrs[pc];
            let op = raw & 0xFF;
            let opname = opcodes[op] || "UNKNOWN";
            let size = getInstrSize(pc);
            let a = (raw >>> 8) & 0xFF;
            let b = (raw >>> 16) & 0xFF;
            let c = (raw >>> 24) & 0xFF;
            let bx = (raw >>> 16) & 0xFFFF;
            let sbx = bx >= 32768 ? bx - 65536 : bx;
            let aux = size > 1 ? p.instrs[pc + 1] : 0;
            let auxVal = size > 1 ? p.consts[(aux >>> 0) & 0xFFFFFF] : null;

            if (opname === "NOP" || opname === "COVERAGE" || opname === "CAPTURE" || opname === "PREPVARARGS" || opname.startsWith("FASTCALL")) {
                pc += size;
                continue;
            }

            if (opname === "FORNPREP" || opname.startsWith("FORGPREP")) {
                let loopTail = pc + sbx + 1;
                let loopEnd = loopTail + getInstrSize(loopTail);
                let loopBody = parseBlock(pc + size, loopTail);
                
                if (opname === "FORNPREP") {
                    body.push({ type: "For", vars: getNamedLocal(a+2, pc)||`v${a+2}`, start: getR(a, pc), end: getR(a+1, pc), step: getR(a+2, pc), body: {type: "Block", body: loopBody} });
                } else {
                    let iter = null;
                    if (opname === "FORGPREP_INEXT") iter = "ipairs";
                    else if (opname === "FORGPREP_NEXT") iter = "pairs";

                    let var1 = getNamedLocal(a+3, pc)||`v${a+3}`;
                    let var2 = getNamedLocal(a+4, pc)||`v${a+4}`;
                    body.push({ type: "ForIn", vars: [var1, var2], iterFunc: iter, iters: getR(a, pc), body: {type: "Block", body: loopBody} });
                }
                pc = loopEnd;
                continue;
            }

            if (opname.startsWith("JUMPIF") || opname.startsWith("JUMPXEQ")) {
                let offset = sbx;
                let fwd = sbx >= 0;
                let cnd;
                let left = getR(a, pc);

                if (opname.startsWith("JUMPXEQ")) {
                    offset = aux | 0;
                    fwd = offset >= 0;
                    let kn = p.consts[bx] ? formatK(p.consts[bx]) : { type: "Literal", value: "unk" };
                    if (opname === "JUMPXEQKNIL") cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: { type: "Literal", value: "nil" } };
                    else if (opname === "JUMPXEQKB") {
                        let kb = ((raw >>> 16) & 0xFF) === 1 ? "true" : "false";
                        cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: { type: "Literal", value: kb } };
                    }
                    else cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: kn };
                } else {
                    let rightR = getR(aux & 0xFF, pc);
                    if (opname === "JUMPIF") cnd = fwd ? { type: "UnaryExpression", op: "not", arg: left } : left;
                    else if (opname === "JUMPIFNOT") cnd = fwd ? left : { type: "UnaryExpression", op: "not", arg: left };
                    else if (opname === "JUMPIFEQ") cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: rightR };
                    else if (opname === "JUMPIFNOTEQ") cnd = { type: "BinaryExpression", op: fwd ? "==" : "~=", left: left, right: rightR };
                    else if (opname === "JUMPIFLE") cnd = { type: "BinaryExpression", op: fwd ? ">" : "<=", left: left, right: rightR };
                    else if (opname === "JUMPIFNOTLE") cnd = { type: "BinaryExpression", op: fwd ? "<=" : ">", left: left, right: rightR };
                    else if (opname === "JUMPIFLT") cnd = { type: "BinaryExpression", op: fwd ? ">=" : "<", left: left, right: rightR };
                    else if (opname === "JUMPIFNOTLT") cnd = { type: "BinaryExpression", op: fwd ? "<" : ">=", left: left, right: rightR };
                }

                let target = pc + offset + 1;

                if (!fwd || target > endPc) {
                    body.push({ type: "If", cond: {type:"UnaryExpression", op:"not", arg:cnd}, body: {type: "Block", body: [{type: "Break"}]} });
                    pc += size;
                    continue;
                }

                let prevPc = pc;
                let curr = pc + size;
                while (curr < target) {
                    prevPc = curr;
                    curr += getInstrSize(curr);
                }

                let hasElse = false;
                let elseTarget = target;
                let trueEnd = target;

                if (prevPc < target && (getOp(prevPc) === "JUMP" || getOp(prevPc) === "JUMPX")) {
                    let prevOp = getOp(prevPc);
                    let jmpOffset = prevOp === "JUMPX" ? (p.instrs[prevPc] >> 8) : (p.instrs[prevPc] >>> 16) & 0xFFFF;
                    if (prevOp !== "JUMPX" && jmpOffset >= 32768) jmpOffset -= 65536;
                    
                    let candElseTarget = prevPc + jmpOffset + 1;
                    if (candElseTarget > target && candElseTarget <= endPc) {
                        hasElse = true;
                        trueEnd = prevPc;
                        elseTarget = candElseTarget;
                    }
                }

                let trueBody = parseBlock(pc + size, trueEnd);
                if (hasElse) {
                    let elseBody = parseBlock(target, elseTarget);
                    body.push({ type: "If", cond: cnd, body: {type:"Block", body:trueBody}, elseBody: {type:"Block", body:elseBody} });
                    pc = elseTarget;
                } else {
                    body.push({ type: "If", cond: cnd, body: {type:"Block", body:trueBody} });
                    pc = target;
                }
                continue;
            }

            if (opname === "JUMP" || opname === "JUMPX") {
                let offset = opname === "JUMPX" ? (raw >> 8) : sbx;
                let target = pc + offset + 1;
                if (target > endPc) {
                    body.push({ type: "Break" });
                }
                pc += size;
                continue;
            }

            let assignNode = null;
            if (opname === "LOADNIL") assignNode = handleRegAssign(a, { type: "Literal", value: "nil" });
            else if (opname === "LOADB") assignNode = handleRegAssign(a, { type: "Literal", value: b === 1 ? "true" : "false" });
            else if (opname === "LOADN") assignNode = handleRegAssign(a, { type: "Literal", value: sbx });
            else if (opname === "LOADK") assignNode = handleRegAssign(a, formatK(p.consts[bx]));
            else if (opname === "LOADKX") assignNode = handleRegAssign(a, formatK(auxVal));
            else if (opname === "MOVE") assignNode = handleRegAssign(a, getR(b, pc));
            else if (opname === "GETGLOBAL") assignNode = handleRegAssign(a, { type: "Identifier", name: formatKVal(auxVal) }, true);
            else if (opname === "SETGLOBAL") body.push({ type: "Assignment", left: { type: "Identifier", name: formatKVal(auxVal) }, right: getR(a, pc) });
            else if (opname === "GETIMPORT") assignNode = handleRegAssign(a, { type: "Identifier", name: formatKVal(auxVal) }, true);
            else if (opname === "GETTABLE") assignNode = handleRegAssign(a, { type: "Index", obj: getR(b, pc), prop: getR(c, pc) });
            else if (opname === "GETTABLEKS") assignNode = handleRegAssign(a, { type: "IndexProp", obj: getR(b, pc), prop: formatKVal(auxVal) });
            else if (opname === "GETTABLEN") assignNode = handleRegAssign(a, { type: "Index", obj: getR(b, pc), prop: { type: "Literal", value: c + 1 } });
            else if (opname === "SETTABLE") {
                if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: getR(c, pc), value: getR(a, pc), isBracket: true });
                else body.push({ type: "Assignment", left: { type: "Index", obj: getR(b, pc), prop: getR(c, pc) }, right: getR(a, pc) });
            }
            else if (opname === "SETTABLEKS") {
                if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: formatKVal(auxVal), value: getR(a, pc), isBracket: false });
                else body.push({ type: "Assignment", left: { type: "IndexProp", obj: getR(b, pc), prop: formatKVal(auxVal) }, right: getR(a, pc) });
            }
            else if (opname === "SETTABLEN") {
                if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: {type:"Literal", value:c+1}, value: getR(a, pc), isBracket: true });
                else body.push({ type: "Assignment", left: { type: "Index", obj: getR(b, pc), prop: { type: "Literal", value: c + 1 } }, right: getR(a, pc) });
            }
            else if (opname === "NAMECALL") {
                namecalls[a] = { obj: getR(b, pc), func: formatKVal(auxVal) };
                regs[a + 1] = getR(b, pc);
            }
            else if (opname === "CALL") {
                let nc = namecalls[a];
                let args = [];
                if (b === 0) args.push({ type: "Vararg" });
                else {
                    let startIdx = nc ? 2 : 1;
                    for (let j = startIdx; j <= b - 1; j++) args.push(getR(a + j, pc));
                }
                
                let callNode = nc ? { type: "Call", isMethod: true, func: nc, args: args } : { type: "Call", isMethod: false, func: getR(a, pc), args: args };
                if (nc) delete namecalls[a];
                
                if (c - 1 === 0) {
                    body.push({ type: "CallStatement", call: callNode }); 
                } else if (c - 1 === 1) {
                    assignNode = handleRegAssign(a, callNode, true);
                } else {
                    let leftVars = [];
                    for (let j = 0; j < c - 1; j++) {
                        let n = getNamedLocal(a + j, pc) || `v${a + j}`;
                        leftVars.push({ type: "Identifier", name: n });
                        regs[a + j] = leftVars[j];
                        definedVars.add(n);
                    }
                    body.push({ type: "MultiAssignment", left: leftVars, right: callNode });
                }
            }
            else if (opname === "RETURN") {
                let rArgs = [];
                if (b > 1) {
                    for (let j = 0; j < b - 1; j++) rArgs.push(getR(a + j, pc));
                } else if (b === 0) rArgs.push({ type: "Vararg" });
                body.push({ type: "Return", args: rArgs });
            }
            else if (opname === "ADD") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "+", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "SUB") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "-", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "MUL") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "*", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "DIV") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "/", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "MOD") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "%", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "POW") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "^", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "ADDK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "+", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "SUBK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "-", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "MULK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "*", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "DIVK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "/", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "MODK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "%", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "POWK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "^", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "SUBRK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "-", left: formatK(p.consts[b]), right: getR(c, pc) });
            else if (opname === "DIVRK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "/", left: formatK(p.consts[b]), right: getR(c, pc) });
            else if (opname === "IDIV") assignNode = handleRegAssign(a, { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b, pc), right: getR(c, pc) }] });
            else if (opname === "IDIVK") assignNode = handleRegAssign(a, { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b, pc), right: formatK(p.consts[c]) }] });
            else if (opname === "AND") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "and", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "OR") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "or", left: getR(b, pc), right: getR(c, pc) });
            else if (opname === "ANDK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "and", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "ORK") assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "or", left: getR(b, pc), right: formatK(p.consts[c]) });
            else if (opname === "NOT") assignNode = handleRegAssign(a, { type: "UnaryExpression", op: "not", arg: getR(b, pc) });
            else if (opname === "MINUS") assignNode = handleRegAssign(a, { type: "UnaryExpression", op: "-", arg: getR(b, pc) });
            else if (opname === "LENGTH") assignNode = handleRegAssign(a, { type: "UnaryExpression", op: "#", arg: getR(b, pc) });
            else if (opname === "CONCAT") {
                let rArgs = [];
                for (let j = b; j <= c; j++) rArgs.push(getR(j, pc));
                assignNode = handleRegAssign(a, { type: "BinaryExpression", op: "..", left: rArgs[0], right: rArgs[1] });
            }
            else if (opname === "GETUPVAL") assignNode = handleRegAssign(a, { type: "Identifier", name: p.upvalues[b] || `upval_${b}` });
            else if (opname === "SETUPVAL") body.push({ type: "Assignment", left: { type: "Identifier", name: p.upvalues[b] || `upval_${b}` }, right: getR(a, pc) });
            else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
                let pIdx = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
                assignNode = handleRegAssign(a, getProtoCode(pIdx), true);
            }
            else if (opname === "NEWTABLE" || opname === "DUPTABLE") {
                assignNode = handleRegAssign(a, { type: "Table", entries: [] }, false);
            }
            else if (opname === "GETVARARGS") assignNode = handleRegAssign(a, { type: "Vararg" });

            if (assignNode) body.push(assignNode);
            
            pc += size;
        }

        function getOp(p_c) { return opcodes[p.instrs[p_c] & 0xFF] || "UNKNOWN"; }
        return body;
    }

    return { type: "Block", body: parseBlock(0, p.instrs.length) };
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
        let allprotos = [];
        let mainindex = 0;

        for (let useGlobalActionFlag of globalActionFlagOptions) {
            r.offset = savedGlobalOffset;
            if (useGlobalActionFlag) r.readbyte();

            try {
                let stringcount = r.readvarint();
                if (stringcount > 100000) continue; 

                let strings = [];
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
                                let tempProtos = [];
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
        let getProtoCode = (pIdx) => {
            let cp = allprotos[pIdx];
            if (!cp || activeProtos.has(pIdx)) return { type: "Function", args: [], body: { type: "Block", body: [] } };
            if (cp.astNode) return cp.astNode;
            
            activeProtos.add(pIdx);
            
            let args = [];
            for (let a = 0; a < cp.numparams; a++) {
                let name = `v${a}`;
                if (cp.locvars) {
                    let loc = cp.locvars.find(v => v.reg === a && v.startpc <= 1);
                    if (loc) name = loc.name;
                }
                args.push(name);
            }
            if (cp.isvararg) args.push("...");
            
            let bodyBlock = lift(cp, allprotos, getProtoCode);
            cp.astNode = { type: "Function", args: args, body: bodyBlock };
            
            activeProtos.delete(pIdx);
            return cp.astNode;
        };
        
        let finalAST = lift(allprotos[mainindex], allprotos, getProtoCode);
        finalAST = optimizeAST(finalAST);
        let finalCode = stringifyAST(finalAST, 0);
        return finalCode.length > 0 ? finalCode : "";

    } catch (e) {
        return "";
    }
}

module.exports = { process };
