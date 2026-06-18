fetch("/vendor/lucide/lucide.svg", { cache: "force-cache" })
  .then(function(r) { return r.text(); })
  .then(function(t) {
    var d = document.createElement("div");
    d.style.display = "none";
    d.setAttribute("aria-hidden", "true");
    d.innerHTML = t;
    document.body.prepend(d);
  })
  .catch(function() {});
