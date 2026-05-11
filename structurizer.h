// structurizer.h
#pragma once
#include "cfg.h"
#include "bytecode_reader.h"
#include <vector>
#include <memory>
#include <string>

struct Stmt;
struct Expr;

struct IfStmt;
struct WhileStmt;
struct RepeatStmt;
struct NumericForStmt;
struct GenericForStmt;
struct AssignStmt;
struct CallStmt;
struct ReturnStmt;
struct BlockStmt;

struct StmtVisitor {
    virtual void visit(IfStmt&) = 0;
    virtual void visit(WhileStmt&) = 0;
    virtual void visit(RepeatStmt&) = 0;
    virtual void visit(NumericForStmt&) = 0;
    virtual void visit(GenericForStmt&) = 0;
    virtual void visit(AssignStmt&) = 0;
    virtual void visit(CallStmt&) = 0;
    virtual void visit(ReturnStmt&) = 0;
    virtual void visit(BlockStmt&) = 0;
};

struct Stmt {
    virtual void accept(StmtVisitor&) = 0;
    virtual ~Stmt() = default;
};

struct Expr {
    virtual ~Expr() = default;
};

struct VarExpr : Expr { std::string name; };
struct ConstExpr : Expr {
    enum class ConstType { NUMBER, INTEGER, STRING, BOOLEAN, NIL };
    ConstType type;
    double num = 0;
    int64_t intval = 0;
    std::string str;
    bool boolean = false;
};
struct BinaryExpr : Expr { std::string op; std::unique_ptr<Expr> left, right; };
struct UnaryExpr : Expr { std::string op; std::unique_ptr<Expr> expr; };
struct CallExpr : Expr { std::unique_ptr<Expr> func; std::vector<std::unique_ptr<Expr>> args; };
struct IndexExpr : Expr { std::unique_ptr<Expr> table, index; };
struct MemberExpr : Expr { std::unique_ptr<Expr> table; std::string field; };

struct IfStmt : Stmt { std::unique_ptr<Expr> cond; std::unique_ptr<BlockStmt> thenBody, elseBody; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct WhileStmt : Stmt { std::unique_ptr<Expr> cond; std::unique_ptr<BlockStmt> body; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct RepeatStmt : Stmt { std::unique_ptr<Expr> cond; std::unique_ptr<BlockStmt> body; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct NumericForStmt : Stmt { std::string var; std::unique_ptr<Expr> from, to, step; std::unique_ptr<BlockStmt> body; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct GenericForStmt : Stmt { std::vector<std::string> vars; std::vector<std::unique_ptr<Expr>> generators; std::unique_ptr<BlockStmt> body; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct AssignStmt : Stmt { std::vector<std::string> vars; std::vector<std::unique_ptr<Expr>> values; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct CallStmt : Stmt { std::unique_ptr<CallExpr> call; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct ReturnStmt : Stmt { std::vector<std::unique_ptr<Expr>> values; void accept(StmtVisitor& v) override { v.visit(*this); } };
struct BlockStmt : Stmt { std::vector<std::unique_ptr<Stmt>> stmts; void accept(StmtVisitor& v) override { v.visit(*this); } };

class Structurizer {
public:
    Structurizer(const BytecodeReader::FunctionProto& func, const BytecodeReader& reader);
    std::unique_ptr<BlockStmt> structurize();
private:
    const BytecodeReader::FunctionProto& m_func;
    const BytecodeReader& m_reader;
    ControlFlowGraph m_cfg;
    std::unique_ptr<BlockStmt> buildAst();
};
