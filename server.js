const express = require('express');
const core = require('./core');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.post('/decompile', (req, res) => {
    try {
        let base64script = req.body.script;
        if (!base64script) return res.status(400).send("-- error missing script");
        let result = core.process(base64script);
        res.set('content-type', 'text/plain');
        res.send(result);
    } catch (ex) {
        let err = ex.stack ? ex.stack.replace(/\n/g, '\n-- ') : ex.message;
        res.status(500).send("-- [MEGGD Engine Crash]\n-- " + err);
    }
});
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});
let port = process.env.PORT || 10000;
app.listen(port, () => {});
