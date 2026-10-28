sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/core/mvc/XMLView"], function (Controller, XMLView) {
  "use strict";
  return Controller.extend("demo.controller.Main", {
    onOpenDialog: function (oEvent) {
      if (!this._dialogPromise) this._dialogPromise = this.loadFragment({ name: "demo.fragment.OrderDialog" });
      this._dialogPromise.then(function (dialog) { dialog.open(); });
    },
    onCloseDialog: function () { this.byId("orderDialog").close(); },
    onCustomerValueHelp: function (oEvent) { this.onOpenDialog(oEvent); },
    onCustomerChange: function (oEvent) { /* Demo: inspect the event without saving business data. */ },
    onLoadDetails: function (oEvent) {
      if (this._detailsPromise) return;
      const view = this.getView();
      this._detailsPromise = XMLView.create({ viewName: "demo.view.Details", id: view.createId("details") })
        .then(function (details) { view.byId("detailsHost").addItem(details); });
    }
  });
});
