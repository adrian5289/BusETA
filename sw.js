// 九巴到站 service worker:只負責接收出門提醒推送,唔做離線快取
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(err){}
  e.waitUntil(self.registration.showNotification(d.title || '九巴到站', {
    body: d.body || '', icon: 'BUS.jpg', badge: 'BUS.jpg',
    tag: d.tag || 'leave', renotify: true, data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type:'window', includeUncontrolled:true }).then(function(list){
    for(var i=0;i<list.length;i++) if('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
