// main.cpp
#include "external/httplib.h"
#include "external/json.hpp"
#include "base64.h"
#include "bytecode_reader.h"
#include "disassembler.h"
#include <iostream>

using json = nlohmann::json;

int main() {
    httplib::Server svr;

    svr.Post("/decompile", [](const httplib::Request &req, httplib::Response &res) {
        try {
            json body = json::parse(req.body);
            if (!body.contains("script")) {
                res.status = 400;
                res.set_content("Missing 'script' field", "text/plain");
                return;
            }
            std::string base64_encoded = body["script"].get<std::string>();
            auto bytecode_vec = base64_decode(base64_encoded);
            if (bytecode_vec.empty()) {
                res.status = 400;
                res.set_content("Invalid base64 data", "text/plain");
                return;
            }

            BytecodeReader reader;
            if (!reader.load(bytecode_vec)) {
                res.status = 500;
                res.set_content("Failed to parse bytecode", "text/plain");
                return;
            }

            Disassembler dis(reader);
            std::string result = dis.disassemble();

            res.set_content(result, "text/plain");
        } catch (const std::exception &e) {
            res.status = 500;
            res.set_content(std::string("Error: ") + e.what(), "text/plain");
        }
    });

    std::cout << "Luau Decompiler server running on http://localhost:8080\n";
    svr.listen("0.0.0.0", 8080);
    return 0;
}
