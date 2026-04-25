const socket = io();

const TABLE_ID = "TABLE";

function $(id){ return document.getElementById(id); }

const nameInput = $("name");
const err = $("err");

// NOTE: last used name is shared, but reconnect identity should be per-tab.
nameInput.value = localStorage.getItem("om_last_name") || localStorage.getItem("om_name") || localStorage.getItem("bm_name") || "";

function showError(message){
  err.textContent = message || "";
  err.hidden = !message;
}

function getName(){
  const n = (nameInput.value || "").trim().slice(0,18);
  return n || "Speler";
}

function join(reconnectKey){
  showError("");
  const name = getName();
  localStorage.setItem("om_last_name", name);
  localStorage.setItem("om_name", name);

  socket.emit("joinTable", { name, reconnectKey }, (res) => {
    if(!res?.ok){
      // If we tried to reconnect and it failed, retry cleanly.
      if(reconnectKey){
        sessionStorage.removeItem(`om_reconnect_${TABLE_ID}`);
        return join(null);
      }
      return showError(res?.error || "Kon niet joinen.");
    }

    if(res.reconnectKey){
      sessionStorage.setItem(`om_reconnect_${TABLE_ID}` , res.reconnectKey);
    }

    location.href = `/room.html`;
  });
}

$("joinTable").addEventListener("click", () => {
  const key = sessionStorage.getItem(`om_reconnect_${TABLE_ID}`) || "";
  join(key || null);
});

// Enter = join
nameInput.addEventListener("keydown", (e) => {
  if(e.key === "Enter") $("joinTable").click();
});
