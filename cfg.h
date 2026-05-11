// cfg.h
#pragma once
#include <vector>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>

struct BasicBlock {
    uint32_t start_pc;
    uint32_t end_pc;
    std::vector<uint32_t> successors;
    std::vector<uint32_t> predecessors;
};

class ControlFlowGraph {
public:
    void build(const std::vector<uint32_t>& instructions);
    const std::vector<BasicBlock>& blocks() const { return m_blocks; }
private:
    std::vector<BasicBlock> m_blocks;
};
