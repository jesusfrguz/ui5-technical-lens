sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/core/mvc/XMLView"], function (Controller, XMLView) {
  "use strict";
  return Controller.extend("demo.controller.Main", {
    onOpenDialog: function () {
      if (!this._dialogPromise) this._dialogPromise = this.loadFragment({ name: "demo.fragment.OrderDialog" });
      this._dialogPromise.then(function (dialog) { dialog.open(); });
    },
    onCloseDialog: function () { this.byId("orderDialog").close(); },
    onLoadDetails: function () {
      if (this._detailsPromise) return;
      const view = this.getView();
      this._detailsPromise = XMLView.create({ viewName: "demo.view.Details", id: view.createId("details") })
        .then(function (details) { view.byId("detailsHost").addItem(details); });
    }
  });
});
