# CMakeLists.txt
cmake_minimum_required(VERSION 3.10)
project(LuauDecompiler)

set(CMAKE_CXX_STANDARD 17)

include_directories(${CMAKE_SOURCE_DIR} ${CMAKE_SOURCE_DIR}/luau ${CMAKE_SOURCE_DIR}/external)

add_executable(luau-decompiler
    main.cpp
    bytecode_reader.cpp
    cfg.cpp
    structurizer.cpp
    codewriter.cpp
    disassembler.cpp
)

find_package(Threads REQUIRED)
target_link_libraries(luau-decompiler Threads::Threads)
