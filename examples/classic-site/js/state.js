// A global shared with app.js: Builder only merges these files because it can prove
// the globals stay the same.
var appState = {
  clicks: 0,
  increment: function () {
    this.clicks += 1;
    return this.clicks;
  },
};
