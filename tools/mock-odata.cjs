"use strict";
// Small, read-only services for the demo. The extension never contacts them itself.
const v2metadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0"><Schema Namespace="Demo" xmlns="http://schemas.microsoft.com/ado/2008/09/edm"><EntityType Name="Order"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String" Nullable="false"/><Property Name="CustomerName" Type="Edm.String"/></EntityType><EntityContainer Name="DemoService" m:IsDefaultEntityContainer="true"><EntitySet Name="Orders" EntityType="Demo.Order"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
const v4metadata = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="Demo" xmlns="http://docs.oasis-open.org/odata/ns/edm"><EntityType Name="Product"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.String" Nullable="false"/><Property Name="Name" Type="Edm.String"/></EntityType><EntityContainer Name="DemoService"><EntitySet Name="Products" EntityType="Demo.Product"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
module.exports = function mockOData(req, res, url) {
  if (!url.pathname.startsWith("/odata/")) return false;
  const v4 = url.pathname.startsWith("/odata/v4/");
  const metadata = url.pathname.endsWith("/$metadata");
  res.setHeader(v4 ? "OData-Version" : "DataServiceVersion", v4 ? "4.0" : "2.0");
  res.setHeader("Content-Type", metadata ? "application/xml; charset=utf-8" : "application/json; charset=utf-8");
  if (metadata) res.end(v4 ? v4metadata : v2metadata);
  else if (v4) res.end(JSON.stringify({ "@odata.context": "$metadata#Products/$entity", ID: "P1", Name: "Equipo de oficina" }));
  else res.end(JSON.stringify({ d: { __metadata: { type: "Demo.Order", uri: "Orders('4500001234')" }, ID: "4500001234", CustomerName: "Cliente demo" } }));
  return true;
};
