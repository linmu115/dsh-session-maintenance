import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { createEngineFixture } from "./helpers.js";
it("keeps binding management behind Engine auth, exact Origin and CSRF; unknown targets cannot open the picker",async()=>{
 const f=await createEngineFixture("vault-management-routes");
 try {
  const server=await f.startServer();const client=new MaintenanceClient({origin:server.origin,token:server.token});
  const action={instanceId:"unknown",profileId:"web",operationId:randomUUID()};
  expect((await fetch(server.origin+"/v1/vault-bindings/instances")).status).toBe(401);
  expect(await client.listVaultBindingInstances()).toEqual([]);
  // Extra display metadata from an instance card must not leak into a strict query.
  const card={instanceId:"unknown",profileId:"web",name:"display label"};
  await expect(client.listManagedVaults(card)).rejects.toMatchObject({status:404,code:"BINDING_INSTANCE_UNKNOWN"});
  await expect(client.createVaultBinding(action)).rejects.toMatchObject({status:404});
  const launch=await client.createDashboardLaunchCode();const claim=await fetch(launch.url,{redirect:"manual"});const cookie=claim.headers.get("set-cookie")!.split(";")[0]!;
  expect((await fetch(server.origin+"/v1/vault-bindings/create",{method:"POST",headers:{cookie,origin:server.origin,"content-type":"application/json"},body:JSON.stringify(action)})).status).toBe(403);
  expect((await fetch(server.origin+"/v1/vault-bindings/create",{method:"POST",headers:{authorization:`Bearer ${server.token}`,origin:"http://evil.invalid","content-type":"application/json"},body:JSON.stringify(action)})).status).toBe(403);
 } finally {await f.cleanupAll();}
});
