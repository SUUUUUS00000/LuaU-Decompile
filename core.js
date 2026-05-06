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
    "FORGLOOP", "LOADKX", "SETLIST", "NEWTABLE", "DUPTABLE",
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
        case "CallStatement": return `${p}${stringifyAST(node.call, 0)}`;
        case "Call": return node.isMethod ? `${stringifyAST(node.func.obj, 0)}:${node.func.func}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})` : `${stringifyAST(node.func, 0)}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})`;
        case "Return": return `${p}return ${node.args.map(a => stringifyAST(a, 0)).join(", ")}`;
        case "If": return `${p}if ${stringifyAST(node.cond, 0)} then\n${stringifyAST(node.body, ind+1)}\n${node.elseBody ? p + "else\n" + stringifyAST(node.elseBody, ind+1) + "\n" : ""}${p}end`;
        case "While": return `${p}while ${stringifyAST(node.cond, 0)} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "For": return `${p}for ${node.vars} = ${stringifyAST(node.start, 0)}, ${stringifyAST(node.end, 0)}${node.step ? ", " + stringifyAST(node.step, 0) : ""} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "ForIn": return `${p}for ${node.vars.join(", ")} in pairs(${stringifyAST(node.iters, 0)}) do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
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
    }
    return "";
}

function lift(p, allprotos, getProtoCode) {
    if (!p || !p.instrs || p.instrs.length === 0) return { type: "Block", body: [] };

    let loopHeaders = {};
    for (let pc = 0; pc < p.instrs.length; pc++) {
        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx >= 32768 ? bx - 65536 : bx;
        if (opname === "JUMPBACK") loopHeaders[pc - bx + 1] = pc;
        else if (opname === "JUMPX" || opname === "JUMP") {
            let offset = opname === "JUMPX" ? (raw >> 8) : sbx;
            if (offset < 0) loopHeaders[pc + offset + 1] = pc;
        }
        if (aux_opcodes.has(opname)) pc++;
    }

    let definedVars = new Set();
    let namecalls = {};
    let pc = 0;
    let regs = new Array(256).fill(null);

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

    let getR = (r) => regs[r] || { type: "Identifier", name: getNamedLocal(r, pc) || `v${r}` };

    let astBody = [];
    let scopeStack = [{ body: astBody, endPc: p.instrs.length, owner: null }];

    let pushNode = (node) => {
        if (node) scopeStack[scopeStack.length - 1].body.push(node);
    };

    let setReg = (reg, node, forceEmit = false) => {
        let name = getNamedLocal(reg, pc);
        if (name) {
            let idNode = { type: "Identifier", name: name };
            if (!definedVars.has(name)) {
                definedVars.add(name);
                pushNode({ type: "LocalAssignment", left: idNode, right: node });
            } else {
                pushNode({ type: "Assignment", left: idNode, right: node });
            }
            regs[reg] = idNode;
        } else if (forceEmit) {
            let tempName = `v${reg}`;
            let idNode = { type: "Identifier", name: tempName };
            if (!definedVars.has(tempName)) {
                definedVars.add(tempName);
                pushNode({ type: "LocalAssignment", left: idNode, right: node });
            } else {
                pushNode({ type: "Assignment", left: idNode, right: node });
            }
            regs[reg] = idNode;
        } else {
            regs[reg] = node;
        }
    };

    while (pc < p.instrs.length) {
        while (scopeStack.length > 1 && pc >= scopeStack[scopeStack.length - 1].endPc) {
            scopeStack.pop();
        }

        if (loopHeaders[pc]) {
            let loopBody = [];
            let whileNode = { type: "While", cond: { type: "Literal", value: "true" }, body: { type: "Block", body: loopBody } };
            pushNode(whileNode);
            scopeStack.push({ body: loopBody, endPc: loopHeaders[pc] + 1, owner: whileNode });
        }

        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let a = (raw >>> 8) & 0xFF;
        let b = (raw >>> 16) & 0xFF;
        let c = (raw >>> 24) & 0xFF;
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx >= 32768 ? bx - 65536 : bx;

        let hasAux = aux_opcodes.has(opname);
        let aux = hasAux ? (p.instrs[pc + 1] || 0) : 0;
        let auxVal = hasAux ? p.consts[(aux >>> 0) & 0xFFFFFF] : null;

        if (opname === "NOP" || opname === "COVERAGE" || opname === "CAPTURE" || opname === "PREPVARARGS") {
            pc += hasAux ? 2 : 1;
            continue;
        }

        if (opname === "LOADNIL") setReg(a, { type: "Literal", value: "nil" });
        else if (opname === "LOADB") setReg(a, { type: "Literal", value: b === 1 ? "true" : "false" });
        else if (opname === "LOADN") setReg(a, { type: "Literal", value: sbx });
        else if (opname === "LOADK") setReg(a, formatK(p.consts[bx]));
        else if (opname === "LOADKX") setReg(a, formatK(auxVal));
        else if (opname === "MOVE") setReg(a, getR(b));
        else if (opname === "GETGLOBAL") setReg(a, { type: "Identifier", name: formatKVal(auxVal) }, true);
        else if (opname === "SETGLOBAL") pushNode({ type: "Assignment", left: { type: "Identifier", name: formatKVal(auxVal) }, right: getR(a) });
        else if (opname === "GETIMPORT") setReg(a, { type: "Identifier", name: formatKVal(auxVal) }, true);
        else if (opname === "GETTABLE") setReg(a, { type: "Index", obj: getR(b), prop: getR(c) });
        else if (opname === "GETTABLEKS") setReg(a, { type: "IndexProp", obj: getR(b), prop: formatKVal(auxVal) });
        else if (opname === "GETTABLEN") setReg(a, { type: "Index", obj: getR(b), prop: { type: "Literal", value: c + 1 } });
        else if (opname === "SETTABLE") {
            if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: getR(c), value: getR(a), isBracket: true });
            else pushNode({ type: "Assignment", left: { type: "Index", obj: getR(b), prop: getR(c) }, right: getR(a) });
        }
        else if (opname === "SETTABLEKS") {
            if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: formatKVal(auxVal), value: getR(a), isBracket: false });
            else pushNode({ type: "Assignment", left: { type: "IndexProp", obj: getR(b), prop: formatKVal(auxVal) }, right: getR(a) });
        }
        else if (opname === "SETTABLEN") {
            if (regs[b] && regs[b].type === "Table") regs[b].entries.push({ key: {type:"Literal", value:c+1}, value: getR(a), isBracket: true });
            else pushNode({ type: "Assignment", left: { type: "Index", obj: getR(b), prop: { type: "Literal", value: c + 1 } }, right: getR(a) });
        }
        else if (opname === "NAMECALL") {
            namecalls[a] = { obj: getR(b), func: formatKVal(auxVal) };
        }
        else if (opname === "CALL") {
            let nc = namecalls[a];
            let args = [];
            if (b === 0) args.push({ type: "Vararg" });
            else {
                let argcount = b - 1;
                let startIdx = nc ? 2 : 1;
                for (let i = startIdx; i <= argcount; i++) args.push(getR(a + i));
            }
            
            let callNode = nc ? { type: "Call", isMethod: true, func: nc, args: args } : { type: "Call", isMethod: false, func: getR(a), args: args };
            if (nc) delete namecalls[a];
            
            if (c - 1 === 0) {
                pushNode({ type: "CallStatement", call: callNode }); 
            } else if (c - 1 === 1) {
                setReg(a, callNode, true);
            } else {
                let retCount = c - 1;
                let leftVars = [];
                for (let i = 0; i < retCount; i++) {
                    let n = getNamedLocal(a + i, pc) || `v${a + i}`;
                    leftVars.push({ type: "Identifier", name: n });
                    regs[a + i] = leftVars[i];
                    definedVars.add(n);
                }
                pushNode({ type: "MultiAssignment", left: leftVars, right: callNode });
            }
        }
        else if (opname === "RETURN") {
            let rArgs = [];
            if (b > 1) {
                for (let i = 0; i < b - 1; i++) rArgs.push(getR(a + i));
            } else if (b === 0) rArgs.push({ type: "Vararg" });
            pushNode({ type: "Return", args: rArgs });
        }
        else if (opname === "JUMP" || opname === "JUMPX") {
            let offset = opname === "JUMPX" ? (raw >> 8) : sbx;
            let target = pc + offset + 1;
            
            let currScope = scopeStack[scopeStack.length - 1];
            if (currScope.owner && currScope.owner.type === "If" && !currScope.owner.elseBody && (pc + 1 === currScope.endPc || pc + (hasAux?2:1) === currScope.endPc)) {
                let elseBody = [];
                currScope.owner.elseBody = { type: "Block", body: elseBody };
                currScope.endPc = target;
                scopeStack.pop();
                scopeStack.push({ body: elseBody, endPc: target, owner: currScope.owner });
            }
        }
        else if (opname.startsWith("JUMPIF") || opname.startsWith("JUMPXEQ")) {
            let fwd = sbx >= 0;
            let cnd;
            let left = getR(a);
            
            if (opname.startsWith("JUMPXEQ")) {
                let offset = aux | 0;
                fwd = offset >= 0;
                let kn = p.consts[bx] ? formatK(p.consts[bx]) : { type: "Literal", value: "unk" };
                if (opname === "JUMPXEQKNIL") cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: { type: "Literal", value: "nil" } };
                else if (opname === "JUMPXEQKB") {
                    let kb = ((raw >>> 16) & 0xFF) === 1 ? "true" : "false";
                    cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: { type: "Literal", value: kb } };
                }
                else cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: kn };
                sbx = offset;
            } else {
                let right = getR(aux & 0xFF);
                if (opname === "JUMPIF") cnd = fwd ? { type: "UnaryExpression", op: "not", arg: left } : left;
                else if (opname === "JUMPIFNOT") cnd = fwd ? left : { type: "UnaryExpression", op: "not", arg: left };
                else if (opname === "JUMPIFEQ") cnd = { type: "BinaryExpression", op: fwd ? "~=" : "==", left: left, right: right };
                else if (opname === "JUMPIFNOTEQ") cnd = { type: "BinaryExpression", op: fwd ? "==" : "~=", left: left, right: right };
                else if (opname === "JUMPIFLE") cnd = { type: "BinaryExpression", op: fwd ? ">" : "<=", left: left, right: right };
                else if (opname === "JUMPIFNOTLE") cnd = { type: "BinaryExpression", op: fwd ? "<=" : ">", left: left, right: right };
                else if (opname === "JUMPIFLT") cnd = { type: "BinaryExpression", op: fwd ? ">=" : "<", left: left, right: right };
                else if (opname === "JUMPIFNOTLT") cnd = { type: "BinaryExpression", op: fwd ? "<" : ">=", left: left, right: right };
            }

            let target = pc + sbx + 1;
            if (fwd) {
                let ifBody = [];
                let ifNode = { type: "If", cond: cnd, body: { type: "Block", body: ifBody } };
                pushNode(ifNode);
                scopeStack.push({ body: ifBody, endPc: target, owner: ifNode });
            } else {
                pushNode({ type: "If", cond: { type: "UnaryExpression", op: "not", arg: cnd }, body: { type: "Block", body: [{type: "Break"}] }});
            }
        }
        else if (opname === "ADD") setReg(a, { type: "BinaryExpression", op: "+", left: getR(b), right: getR(c) });
        else if (opname === "SUB") setReg(a, { type: "BinaryExpression", op: "-", left: getR(b), right: getR(c) });
        else if (opname === "MUL") setReg(a, { type: "BinaryExpression", op: "*", left: getR(b), right: getR(c) });
        else if (opname === "DIV") setReg(a, { type: "BinaryExpression", op: "/", left: getR(b), right: getR(c) });
        else if (opname === "MOD") setReg(a, { type: "BinaryExpression", op: "%", left: getR(b), right: getR(c) });
        else if (opname === "POW") setReg(a, { type: "BinaryExpression", op: "^", left: getR(b), right: getR(c) });
        else if (opname === "ADDK") setReg(a, { type: "BinaryExpression", op: "+", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "SUBK") setReg(a, { type: "BinaryExpression", op: "-", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "MULK") setReg(a, { type: "BinaryExpression", op: "*", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "DIVK") setReg(a, { type: "BinaryExpression", op: "/", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "MODK") setReg(a, { type: "BinaryExpression", op: "%", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "POWK") setReg(a, { type: "BinaryExpression", op: "^", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "SUBRK") setReg(a, { type: "BinaryExpression", op: "-", left: formatK(p.consts[b]), right: getR(c) });
        else if (opname === "DIVRK") setReg(a, { type: "BinaryExpression", op: "/", left: formatK(p.consts[b]), right: getR(c) });
        else if (opname === "IDIV") setReg(a, { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b), right: getR(c) }] });
        else if (opname === "IDIVK") setReg(a, { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b), right: formatK(p.consts[c]) }] });
        else if (opname === "AND") setReg(a, { type: "BinaryExpression", op: "and", left: getR(b), right: getR(c) });
        else if (opname === "OR") setReg(a, { type: "BinaryExpression", op: "or", left: getR(b), right: getR(c) });
        else if (opname === "ANDK") setReg(a, { type: "BinaryExpression", op: "and", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "ORK") setReg(a, { type: "BinaryExpression", op: "or", left: getR(b), right: formatK(p.consts[c]) });
        else if (opname === "NOT") setReg(a, { type: "UnaryExpression", op: "not", arg: getR(b) });
        else if (opname === "MINUS") setReg(a, { type: "UnaryExpression", op: "-", arg: getR(b) });
        else if (opname === "LENGTH") setReg(a, { type: "UnaryExpression", op: "#", arg: getR(b) });
        else if (opname === "CONCAT") {
            let rArgs = [];
            for (let i = b; i <= c; i++) rArgs.push(getR(i));
            setReg(a, { type: "BinaryExpression", op: "..", left: rArgs[0], right: rArgs[1] });
        }
        else if (opname === "GETUPVAL") setReg(a, { type: "Identifier", name: p.upvalues[b] || `upval_${b}` });
        else if (opname === "SETUPVAL") pushNode({ type: "Assignment", left: { type: "Identifier", name: p.upvalues[b] || `upval_${b}` }, right: getR(a) });
        else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
            let protoIdx = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
            setReg(a, getProtoCode(protoIdx), true);
        }
        else if (opname === "NEWTABLE" || opname === "DUPTABLE") {
            setReg(a, { type: "Table", entries: [] }, false);
        }
        else if (opname === "SETLIST") {
            let count = c - 1;
            let startIdx = aux; 
            if (count > 0) {
                for (let i = 0; i < count; i++) {
                    if (regs[a] && regs[a].type === "Table") regs[a].entries.push({ key: {type:"Literal", value: startIdx+i}, value: getR(b+i), isBracket: true });
                    else pushNode({ type: "Assignment", left: { type: "Index", obj: getR(a), prop: { type: "Literal", value: startIdx + i } }, right: getR(b + i) });
                }
            }
        }
        else if (opname === "GETVARARGS") setReg(a, { type: "Vararg" });
        else if (opname === "FORNPREP") {
            let loopVar = getNamedLocal(a + 2, pc) || `v${a + 2}`;
            let forBody = [];
            let target = pc + sbx + 1;
            let forNode = { type: "For", vars: loopVar, start: getR(a), end: getR(a+1), step: getR(a+2), body: { type: "Block", body: forBody } };
            pushNode(forNode);
            scopeStack.push({ body: forBody, endPc: target, owner: forNode });
        }
        else if (opname.startsWith("FORGPREP")) {
            let var1 = getNamedLocal(a + 3, pc) || `v${a + 3}`;
            let var2 = getNamedLocal(a + 4, pc) || `v${a + 4}`;
            let forBody = [];
            let target = pc + sbx + 1;
            let forNode = { type: "ForIn", vars: [var1, var2], iters: getR(a), body: { type: "Block", body: forBody } };
            pushNode(forNode);
            scopeStack.push({ body: forBody, endPc: target, owner: forNode });
        }

        pc++;
        if (hasAux) pc++;
    }
    
    return { type: "Block", body: astBody };
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
        let finalCode = stringifyAST(finalAST, 0);
        return finalCode.length > 0 ? finalCode : "";

    } catch (e) {
        return "";
    }
}

module.exports = { process };
