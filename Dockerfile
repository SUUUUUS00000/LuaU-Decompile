# Dockerfile
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y \
    g++ \
    cmake \
    make \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN mkdir -p external && \
    curl -L -o external/httplib.h https://raw.githubusercontent.com/yhirose/cpp-httplib/master/httplib.h && \
    curl -L -o external/json.hpp https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp

RUN mkdir build && cd build && cmake .. && make

EXPOSE 8080

CMD ["./build/luau-decompiler"]
