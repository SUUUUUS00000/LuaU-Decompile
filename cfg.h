// cfg.h
#pragma once
#include <vector>
#include <cstdint>
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
    size_t numBlocks() const { return m_blocks.size(); }
    const BasicBlock& block(size_t idx) const { return m_blocks[idx]; }
private:
    std::vector<BasicBlock> m_blocks;
    std::unordered_set<uint32_t> leaders;
    void findLeaders(const std::vector<uint32_t>& instructions);
    void buildBlocks(const std::vector<uint32_t>& instructions);
    void computeEdges(const std::vector<uint32_t>& instructions);
};
