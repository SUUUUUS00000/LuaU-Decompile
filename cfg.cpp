// cfg.cpp
#include "cfg.h"
#include "luau/Bytecode.h"
#include "BytecodeUtils.h"
#include <algorithm>

void ControlFlowGraph::build(const std::vector<uint32_t>& instructions) {
    findLeaders(instructions);
    buildBlocks(instructions);
    computeEdges(instructions);
}

void ControlFlowGraph::findLeaders(const std::vector<uint32_t>& instructions) {
    leaders.clear();
    leaders.insert(0);
    for (size_t pc = 0; pc < instructions.size(); ) {
        uint32_t insn = instructions[pc];
        LuauOpcode op = static_cast<LuauOpcode>(LUAU_INSN_OP(insn));
        int target = getJumpTarget(insn, pc);
        if (target >= 0 && target < int(instructions.size())) {
            leaders.insert(target);
        }
        if (op == LOP_JUMP || op == LOP_JUMPBACK || op == LOP_JUMPX || op == LOP_RETURN) {
            if (pc + 1 < instructions.size()) {
                leaders.insert(pc + 1);
            }
        }
        if (isFastCall(op)) {
            leaders.insert(pc + 1);
        }
        pc += getOpLength(op);
    }
}

void ControlFlowGraph::buildBlocks(const std::vector<uint32_t>& instructions) {
    m_blocks.clear();
    std::vector<uint32_t> sortedLeaders(leaders.begin(), leaders.end());
    std::sort(sortedLeaders.begin(), sortedLeaders.end());
    for (size_t i = 0; i < sortedLeaders.size(); ++i) {
        uint32_t start = sortedLeaders[i];
        uint32_t end = (i + 1 < sortedLeaders.size()) ? sortedLeaders[i + 1] : instructions.size();
        BasicBlock block;
        block.start_pc = start;
        block.end_pc = end;
        m_blocks.push_back(block);
    }
}

void ControlFlowGraph::computeEdges(const std::vector<uint32_t>& instructions) {
    for (size_t i = 0; i < m_blocks.size(); ++i) {
        BasicBlock& block = m_blocks[i];
        if (block.end_pc == 0) continue;
        uint32_t lastInsn = instructions[block.end_pc - 1];
        LuauOpcode op = static_cast<LuauOpcode>(LUAU_INSN_OP(lastInsn));
        int target = getJumpTarget(lastInsn, block.end_pc - 1);
        if (target >= 0) {
            for (size_t j = 0; j < m_blocks.size(); ++j) {
                if (m_blocks[j].start_pc == target) {
                    block.successors.push_back(j);
                    m_blocks[j].predecessors.push_back(i);
                    break;
                }
            }
        }
        if (op != LOP_JUMP && op != LOP_JUMPBACK && op != LOP_JUMPX && op != LOP_RETURN) {
            if (i + 1 < m_blocks.size() && m_blocks[i + 1].start_pc == block.end_pc) {
                block.successors.push_back(i + 1);
                m_blocks[i + 1].predecessors.push_back(i);
            }
        }
        if (isFastCall(op)) {
            if (block.end_pc < instructions.size()) {
                uint32_t callInsn = instructions[block.end_pc];
                LuauOpcode callOp = static_cast<LuauOpcode>(LUAU_INSN_OP(callInsn));
                if (callOp == LOP_CALL) {
                    uint32_t callNextPc = block.end_pc + getOpLength(callOp);
                    for (size_t j = 0; j < m_blocks.size(); ++j) {
                        if (m_blocks[j].start_pc == callNextPc) {
                            block.successors.push_back(j);
                            m_blocks[j].predecessors.push_back(i);
                            break;
                        }
                    }
                }
            }
        }
    }
}
