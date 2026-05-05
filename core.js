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
    if (!k) return { type: "Literal", value: "nil" };
    if (k.t === 'str') return { type: "Literal", value: `"${k.v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"` };
    if (k.t === 'bool') return { type: "Literal", value: k.v ? "true" : "false" };
    if (k.t === 'closure') return { type: "Literal", value: `closure_${k.id}` };
    if (k.t === 'table') return { type: "Table" };
    if (k.t === 'import') return { type: "Literal", value: k.v };
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

function stringifyAST(node, ind) {
    if (!node) return "";
    let p = "    ".repeat(ind);
    if (typeof node === 'string') return node;
    switch (node.type) {
        case "Block": return node.body.map(n => stringifyAST(n, ind)).filter(x=>x).join("\n");
        case "Assignment": return `${p}${stringifyAST(node.left, 0)} = ${stringifyAST(node.right, 0)}`;
        case "LocalAssignment": return `${p}local ${stringifyAST(node.left, 0)} = ${stringifyAST(node.right, 0)}`;
        case "CallStatement": return `${p}${stringifyAST(node.call, 0)}`;
        case "Call": return node.isMethod ? `${stringifyAST(node.func.obj, 0)}:${node.func.func}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})` : `${stringifyAST(node.func, 0)}(${node.args.map(a => stringifyAST(a, 0)).join(", ")})`;
        case "Return": return `${p}return ${node.args.map(a => stringifyAST(a, 0)).join(", ")}`;
        case "If": return `${p}if ${stringifyAST(node.cond, 0)} then\n${stringifyAST(node.body, ind+1)}\n${node.elseBody ? p + "else\n" + stringifyAST(node.elseBody, ind+1) + "\n" : ""}${p}end`;
        case "While": return `${p}while ${stringifyAST(node.cond, 0)} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "For": return `${p}for ${node.vars} = ${stringifyAST(node.start, 0)}, ${stringifyAST(node.end, 0)}${node.step ? ", " + stringifyAST(node.step, 0) : ""} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "ForIn": return `${p}for ${node.vars.join(", ")} in ${stringifyAST(node.iters, 0)} do\n${stringifyAST(node.body, ind+1)}\n${p}end`;
        case "Break": return `${p}break`;
        case "Index": return `${stringifyAST(node.obj, 0)}[${stringifyAST(node.prop, 0)}]`;
        case "IndexProp": return `${stringifyAST(node.obj, 0)}.${node.prop}`;
        case "Table": return `{}`;
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

function lift(p, allprotos, indnt, getProtoCode) {
    if (!p || !p.instrs || p.instrs.length === 0) return "";
    
    let basicBlocks = new Set([0]);
    for(let pc = 0; pc < p.instrs.length; pc++) {
        let raw = p.instrs[pc];
        let op = raw & 0xFF;
        let opname = opcodes[op] || "UNKNOWN";
        let bx = (raw >>> 16) & 0xFFFF;
        let sbx = bx; if (sbx >= 32768) sbx -= 65536;
        let hasAux = aux_opcodes.has(opname);
        
        if (opname.startsWith("JUMP") || opname.startsWith("FOR")) {
            let target = pc + sbx + 1;
            if (opname === "JUMPX") target = pc + (raw >> 8) + 1;
            if (opname === "JUMPBACK") target = pc - bx + 1;
            basicBlocks.add(target);
            basicBlocks.add(pc + (hasAux ? 2 : 1));
        } else if (opname === "RETURN") {
            if (pc + 1 < p.instrs.length) basicBlocks.add(pc + 1);
        }
        if (hasAux) pc++;
    }

    let regs = new Array(256).fill(null);
    let definedVars = new Set();
    let pc = 0;
    
    let getVarName = (reg) => {
        if (p.locvars) {
            let loc = p.locvars.find(v => v.reg === reg && v.startpc <= pc && v.endpc >= pc);
            if (loc) return loc.name;
        }
        return `v${reg}`;
    };

    for (let i = 0; i < p.numparams; i++) {
        let name = getVarName(i);
        regs[i] = { type: "Identifier", name: name };
        definedVars.add(name);
    }

    let getR = (r) => regs[r] !== null ? regs[r] : { type: "Identifier", name: getVarName(r) };

    let astBody = [];
    let scopeStack = [astBody];
    let ends = {};

    let pushNode = (node) => {
        if (node) scopeStack[scopeStack.length - 1].push(node);
    };

    let assignVar = (reg, valNode) => {
        let varName = getVarName(reg);
        if (definedVars.has(varName)) {
            pushNode({ type: "Assignment", left: { type: "Identifier", name: varName }, right: valNode });
        } else {
            definedVars.add(varName);
            pushNode({ type: "LocalAssignment", left: { type: "Identifier", name: varName }, right: valNode });
        }
        regs[reg] = { type: "Identifier", name: varName };
    };

    while (pc < p.instrs.length) {
        if (ends[pc]) {
            for(let i=0; i<ends[pc]; i++) {
                if (scopeStack.length > 1) scopeStack.pop();
            }
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
            if (opname === "LOADNIL") regs[a] = { type: "Literal", value: "nil" };
            else if (opname === "LOADB") { 
                regs[a] = { type: "Literal", value: b === 1 ? "true" : "false" }; 
                if (c > 0) {
                    let target = pc + c + 1;
                    ends[target] = (ends[target] || 0) + 1;
                }
            }
            else if (opname === "LOADN") regs[a] = { type: "Literal", value: sbx };
            else if (opname === "LOADK") regs[a] = formatK(p.consts[bx]);
            else if (opname === "LOADKX") regs[a] = formatK(auxVal);
            else if (opname === "MOVE") regs[a] = getR(b);
            else if (opname === "GETGLOBAL") regs[a] = { type: "Identifier", name: formatKVal(auxVal) };
            else if (opname === "SETGLOBAL") pushNode({ type: "Assignment", left: { type: "Identifier", name: formatKVal(auxVal) }, right: getR(a) });
            else if (opname === "GETIMPORT") regs[a] = { type: "Identifier", name: formatKVal(auxVal) };
            else if (opname === "GETTABLE") regs[a] = { type: "Index", obj: getR(b), prop: getR(c) };
            else if (opname === "GETTABLEKS") regs[a] = { type: "IndexProp", obj: getR(b), prop: formatKVal(auxVal) };
            else if (opname === "GETTABLEN") regs[a] = { type: "Index", obj: getR(b), prop: { type: "Literal", value: c + 1 } };
            else if (opname === "SETTABLE") pushNode({ type: "Assignment", left: { type: "Index", obj: getR(b), prop: getR(c) }, right: getR(a) });
            else if (opname === "SETTABLEKS") pushNode({ type: "Assignment", left: { type: "IndexProp", obj: getR(b), prop: formatKVal(auxVal) }, right: getR(a) });
            else if (opname === "SETTABLEN") pushNode({ type: "Assignment", left: { type: "Index", obj: getR(b), prop: { type: "Literal", value: c + 1 } }, right: getR(a) });
            else if (opname === "NAMECALL") {
                regs[a] = { m: true, obj: getR(b), func: formatKVal(auxVal) };
                regs[a + 1] = getR(b);
            }
            else if (opname === "CALL") {
                let f = regs[a];
                let args = [];
                if (b === 0) {
                    args.push({ type: "Vararg" });
                } else {
                    let argcount = b - 1;
                    let startIdx = (f && f.m) ? 2 : 1;
                    for (let i = startIdx; i <= argcount; i++) args.push(getR(a + i));
                }
                let callNode;
                if (f && f.m) callNode = { type: "Call", isMethod: true, func: f, args: args };
                else callNode = { type: "Call", isMethod: false, func: f || { type: "Identifier", name: getVarName(a) }, args: args };
                
                if (c - 1 === 0) pushNode({ type: "CallStatement", call: callNode }); 
                else assignVar(a, callNode);
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
                if (offset < 0) pushNode({ type: "Break" });
            }
            else if (opname === "JUMPBACK") {
                let offset = -bx;
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
                if (!fwd) {
                    pushNode({ type: "If", cond: cnd, body: { type: "Block", body: [{ type: "Break" }] } });
                } else {
                    let newBlock = { type: "Block", body: [] };
                    pushNode({ type: "If", cond: cnd, body: newBlock });
                    scopeStack.push(newBlock.body);
                    ends[target] = (ends[target] || 0) + 1;
                }
            }
            else if (opname === "ADD") regs[a] = { type: "BinaryExpression", op: "+", left: getR(b), right: getR(c) };
            else if (opname === "SUB") regs[a] = { type: "BinaryExpression", op: "-", left: getR(b), right: getR(c) };
            else if (opname === "MUL") regs[a] = { type: "BinaryExpression", op: "*", left: getR(b), right: getR(c) };
            else if (opname === "DIV") regs[a] = { type: "BinaryExpression", op: "/", left: getR(b), right: getR(c) };
            else if (opname === "MOD") regs[a] = { type: "BinaryExpression", op: "%", left: getR(b), right: getR(c) };
            else if (opname === "POW") regs[a] = { type: "BinaryExpression", op: "^", left: getR(b), right: getR(c) };
            else if (opname === "ADDK") regs[a] = { type: "BinaryExpression", op: "+", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "SUBK") regs[a] = { type: "BinaryExpression", op: "-", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "MULK") regs[a] = { type: "BinaryExpression", op: "*", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "DIVK") regs[a] = { type: "BinaryExpression", op: "/", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "MODK") regs[a] = { type: "BinaryExpression", op: "%", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "POWK") regs[a] = { type: "BinaryExpression", op: "^", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "SUBRK") regs[a] = { type: "BinaryExpression", op: "-", left: formatK(p.consts[b]), right: getR(c) };
            else if (opname === "DIVRK") regs[a] = { type: "BinaryExpression", op: "/", left: formatK(p.consts[b]), right: getR(c) };
            else if (opname === "IDIV") regs[a] = { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b), right: getR(c) }] };
            else if (opname === "IDIVK") regs[a] = { type: "Call", isMethod: false, func: { type: "Identifier", name: "math.floor" }, args: [{ type: "BinaryExpression", op: "/", left: getR(b), right: formatK(p.consts[c]) }] };
            else if (opname === "AND") regs[a] = { type: "BinaryExpression", op: "and", left: getR(b), right: getR(c) };
            else if (opname === "OR") regs[a] = { type: "BinaryExpression", op: "or", left: getR(b), right: getR(c) };
            else if (opname === "ANDK") regs[a] = { type: "BinaryExpression", op: "and", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "ORK") regs[a] = { type: "BinaryExpression", op: "or", left: getR(b), right: formatK(p.consts[c]) };
            else if (opname === "NOT") regs[a] = { type: "UnaryExpression", op: "not", arg: getR(b) };
            else if (opname === "MINUS") regs[a] = { type: "UnaryExpression", op: "-", arg: getR(b) };
            else if (opname === "LENGTH") regs[a] = { type: "UnaryExpression", op: "#", arg: getR(b) };
            else if (opname === "CONCAT") {
                let rArgs = [];
                for (let i = b; i <= c; i++) rArgs.push(getR(i));
                regs[a] = { type: "BinaryExpression", op: "..", left: rArgs[0], right: rArgs[1] };
            }
            else if (opname === "GETUPVAL") regs[a] = { type: "Identifier", name: p.upvalues[b] || `upval_${b}` };
            else if (opname === "SETUPVAL") pushNode({ type: "Assignment", left: { type: "Identifier", name: p.upvalues[b] || `upval_${b}` }, right: getR(a) });
            else if (opname === "NEWCLOSURE" || opname === "DUPCLOSURE") {
                let protoIdx = opname === "NEWCLOSURE" ? bx : (p.consts[bx] ? p.consts[bx].id : 0);
                assignVar(a, getProtoCode(protoIdx, 0));
            }
            else if (opname === "NEWTABLE" || opname === "DUPTABLE") {
                assignVar(a, { type: "Table" });
            }
            else if (opname === "SETLIST") {
                let count = c - 1;
                let startIdx = aux; 
                if (count > 0) {
                    for (let i = 0; i < count; i++) {
                        pushNode({ type: "Assignment", left: { type: "Index", obj: getR(a), prop: { type: "Literal", value: startIdx + i } }, right: getR(b + i) });
                    }
                }
            }
            else if (opname === "GETVARARGS") regs[a] = { type: "Vararg" };
            else if (opname === "FORNPREP") {
                let loopVar = getVarName(a + 2);
                let newBlock = { type: "Block", body: [] };
                pushNode({ type: "For", vars: loopVar, start: getR(a), end: getR(a+1), step: getR(a+2), body: newBlock });
                scopeStack.push(newBlock.body);
                let target = pc + sbx + 1;
                ends[target] = (ends[target] || 0) + 1;
            }
            else if (opname.startsWith("FORGPREP")) {
                let var1 = getVarName(a + 3);
                let var2 = getVarName(a + 4);
                let newBlock = { type: "Block", body: [] };
                pushNode({ type: "ForIn", vars: [var1, var2], iters: getR(a), body: newBlock });
                scopeStack.push(newBlock.body);
                let target = pc + sbx + 1;
                ends[target] = (ends[target] || 0) + 1;
            }
            else if (opname === "BREAK") {
                pushNode({ type: "Break" });
            }
        } catch (e) {}

        pc++;
        if (hasAux) pc++;
    }
    
    return stringifyAST({ type: "Block", body: astBody }, indnt);
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
            if (!cp) return { type: "Function", args: [], body: { type: "Block", body: [] } };
            if (activeProtos.has(pIdx)) return { type: "Function", args: [], body: { type: "Block", body: [] } };
            if (cp.astNode) return cp.astNode;
            
            activeProtos.add(pIdx);
            
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
            
            let bodyStr = lift(cp, allprotos, indnt + 1, getProtoCode);
            cp.astNode = { type: "Identifier", name: `function(${args.join(", ")})\n${bodyStr}\n${"    ".repeat(indnt)}end` };
            
            activeProtos.delete(pIdx);
            return cp.astNode;
        };
        
        let finalCode = lift(allprotos[mainindex], allprotos, 0, getProtoCode);
        return finalCode.length > 0 ? finalCode : "";

    } catch (e) {
        return "";
    }
}

module.exports = { process };
