// Built from the public schemaVersion=2 manifest inspected on 2026-10-21.
// Local deterministic installer bytes only; never used by the production app.
const http=require('http');
const {createHash}=require('crypto');
const bytes=Buffer.from('postman simulation installer fixture - never install');
const sha=createHash('sha256').update(bytes).digest('hex');
http.createServer((req,res)=>{
  if(req.url==='/latest/manifest'){
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({schemaVersion:2,generatedAt:'2026-10-21T00:00:00Z',version:'3.1623.0',sources:{windows:{x64:{platform:'win32',arch:'x64',format:'msix',version:'3.1623.0',assetName:'Claude-win-x64.msix',sha256:sha,contentLength:bytes.length}}}}));
  }else if(req.url==='/latest/win-x64'){res.setHeader('Content-Length',bytes.length);res.end(bytes);}
  else {res.writeHead(501);res.end('Endpoint not modeled');}
}).listen(process.env.PORT||4901);
