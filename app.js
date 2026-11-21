/* Image GEO Tagger — core logic (built from scratch, v2)
 * 3-step flow: 1 Upload -> 2 Pick location -> 3 Tag & Download.
 * Same location for all (default) or a different location per image.
 * JPEGs get real GPS EXIF via piexifjs. PNG/WebP have no standard GPS
 * EXIF, so they download unchanged. Everything runs in the browser;
 * photos never leave the device.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var images = [];          // { id, file, name, type, size, objectUrl, tagged, taggedBlob, taggedName, exifApplied, taggedNote, existingGps, gpsAction, location }
  var selected = new Set();
  var location = null;      // global { lat, lng, place }
  var mode = 'same';        // 'same' | 'per'
  var marker = null;
  var map = null;
  var nextId = 1;
  var recent = loadRecent();
  var reverseToken = 0;

  /* ---------- Toasts ---------- */
  function showToast(message, type) {
    var container = $('toastContainer');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  /* ---------- Helpers ---------- */
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function degToDmsRational(decimal) {
    var abs = Math.abs(decimal);
    var deg = Math.floor(abs);
    var minFloat = (abs - deg) * 60;
    var min = Math.floor(minFloat);
    var sec = (minFloat - min) * 60;
    return [[deg, 1], [min, 1], [Math.round(sec * 100), 100]];
  }

  function rationalToFloat(r) { return r[0] / (r[1] || 1); }

  function dmsToDecimal(dms, ref) {
    var d = rationalToFloat(dms[0]) + rationalToFloat(dms[1]) / 60 + rationalToFloat(dms[2]) / 3600;
    return (ref === 'S' || ref === 'W') ? -d : d;
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var mime = parts[0].match(/:(.*?);/)[1];
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  function taggedFileName(name) {
    var dot = name.lastIndexOf('.');
    if (dot === -1) return name + '_tagged';
    return name.slice(0, dot) + '_tagged' + name.slice(dot);
  }

  function coordsText(lat, lng) { return lat.toFixed(6) + ', ' + lng.toFixed(6); }

  function loadRecent() {
    try {
      var raw = localStorage.getItem('geotagger-recent');
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveRecent() {
    try { localStorage.setItem('geotagger-recent', JSON.stringify(recent)); } catch (e) { /* private mode — ignore */ }
  }

  /* ---------- Map ---------- */
  function initMap() {
    if (typeof L === 'undefined') {
      showToast('Map library (Leaflet) failed to load. Check your connection and reload.', 'error');
      return;
    }
    map = L.map('map').setView([30.3753, 69.3451], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    map.on('click', function (e) { setLocation(e.latlng.lat, e.latlng.lng, false, null); });
  }

  function setLocation(lat, lng, pan, place) {
    location = { lat: lat, lng: lng, place: place || null };
    if (marker) marker.setLatLng([lat, lng]);
    else if (map) marker = L.marker([lat, lng]).addTo(map);
    if (pan && map) map.setView([lat, lng], Math.max(map.getZoom(), 12));
    $('latDisplay').textContent = lat.toFixed(6);
    $('lngDisplay').textContent = lng.toFixed(6);
    $('latInput').value = lat.toFixed(6);
    $('lngInput').value = lng.toFixed(6);
    if (mode === 'per' && selected.size) {
      selected.forEach(function (id) {
        var img = images.find(function (x) { return x.id === id; });
        if (img) img.location = { lat: lat, lng: lng, place: place || null };
      });
      renderGallery();
    }
    $('placeName').textContent = place ? '📍 ' + place : '📍 ' + coordsText(lat, lng) + ' — looking up place name…';
    pushRecent(lat, lng, place);
    reverseGeocode(lat, lng);
    updateUI();
  }

  async function reverseGeocode(lat, lng) {
    var token = ++reverseToken;
    try {
      var url = 'https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=' + lat + '&lon=' + lng;
      var res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      var data = await res.json();
      if (token !== reverseToken || !data.display_name) return;
      var short = data.display_name.split(',').slice(0, 3).join(',').trim();
      location.place = short;
      $('placeName').textContent = '📍 ' + short;
      pushRecent(lat, lng, short);
    } catch (e) { /* offline — coordinates alone are enough */ }
  }

  async function searchPlace() {
    var query = $('searchInput').value.trim();
    if (!query) { showToast('Type a place name to search.', 'error'); return; }
    try {
      var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
      var res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('Search failed');
      var results = await res.json();
      if (!results.length) { showToast('No place found for "' + query + '".', 'error'); return; }
      setLocation(parseFloat(results[0].lat), parseFloat(results[0].lon), true, results[0].display_name);
      showToast('Found: ' + results[0].display_name, 'success');
    } catch (err) {
      showToast('Place search failed. Check your connection and try again.', 'error');
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { showToast('Geolocation is not supported by this browser.', 'error'); return; }
    showToast('Getting your current location…');
    navigator.geolocation.getCurrentPosition(
      function (pos) { setLocation(pos.coords.latitude, pos.coords.longitude, true, null); showToast('Using your current location.', 'success'); },
      function () { showToast('Could not get your location — check the browser permission and try again.', 'error'); },
      { timeout: 10000 }
    );
  }

  function pushRecent(lat, lng, place) {
    var key = lat.toFixed(4) + ',' + lng.toFixed(4);
    recent = recent.filter(function (r) { return r.key !== key; });
    recent.unshift({ key: key, lat: lat, lng: lng, place: place || null });
    recent = recent.slice(0, 3);
    saveRecent();
    renderRecent();
  }

  function renderRecent() {
    var wrap = $('recentWrap');
    var list = $('recentList');
    list.innerHTML = '';
    if (!recent.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    recent.forEach(function (r) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      chip.textContent = r.place ? r.place.split(',')[0] : coordsText(r.lat, r.lng);
      chip.title = r.place || coordsText(r.lat, r.lng);
      chip.addEventListener('click', function () { setLocation(r.lat, r.lng, true, r.place); });
      list.appendChild(chip);
    });
  }

  /* ---------- Images ---------- */
  function isAccepted(file) {
    if (ACCEPTED_TYPES.indexOf(file.type) !== -1) return true;
    return /\.(jpe?g|png|webp)$/i.test(file.name);
  }

  function extractExistingGps(dataUrl) {
    try {
      if (typeof piexif === 'undefined') return null;
      var exif = piexif.load(dataUrl);
      var gps = exif.GPS || {};
      if (!gps[piexif.GPSIFD.GPSLatitude] || !gps[piexif.GPSIFD.GPSLongitude]) return null;
      return {
        lat: dmsToDecimal(gps[piexif.GPSIFD.GPSLatitude], gps[piexif.GPSIFD.GPSLatitudeRef] || 'N'),
        lng: dmsToDecimal(gps[piexif.GPSIFD.GPSLongitude], gps[piexif.GPSIFD.GPSLongitudeRef] || 'E')
      };
    } catch (e) { return null; }
  }

  async function addFiles(fileList) {
    var added = 0, rejected = 0;
    var files = Array.prototype.slice.call(fileList);
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!isAccepted(file)) { rejected++; continue; }
      var img = {
        id: nextId++, file: file, name: file.name, type: file.type || 'image/jpeg',
        size: file.size, objectUrl: URL.createObjectURL(file),
        tagged: false, taggedBlob: null, taggedName: null, exifApplied: false,
        taggedNote: '', existingGps: null, gpsAction: 'replace', location: null
      };
      if (/\.jpe?g$/i.test(file.name) || file.type === 'image/jpeg') {
        try { img.existingGps = extractExistingGps(await readFileAsDataUrl(file)); } catch (e) { /* no EXIF */ }
      }
      images.push(img);
      added++;
    }
    if (rejected) showToast(rejected + ' file(s) skipped — only JPEG, PNG and WebP are accepted.', 'error');
    if (added) {
      renderGallery();
      updateUI();
      showToast(added + ' image(s) added. Click a photo to select it.', 'success');
    }
  }

  function renderGallery() {
    var gallery = $('gallery');
    gallery.innerHTML = '';
    if (!images.length) {
      var note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = 'No photos yet — upload some to start Step 1.';
      gallery.appendChild(note);
      return;
    }
    images.forEach(function (img) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb' + (selected.has(img.id) ? ' selected' : '');
      btn.title = img.name;
      btn.setAttribute('aria-pressed', selected.has(img.id) ? 'true' : 'false');
      var thumb = document.createElement('img');
      thumb.src = img.objectUrl;
      thumb.alt = img.name;
      btn.appendChild(thumb);
      if (img.tagged) {
        var badge = document.createElement('span');
        badge.className = 'tagged-badge';
        badge.textContent = 'TAGGED';
        btn.appendChild(badge);
      }
      if (img.existingGps) {
        var gps = document.createElement('span');
        gps.className = 'gps-chip';
        gps.textContent = 'GPS ' + img.existingGps.lat.toFixed(4) + ', ' + img.existingGps.lng.toFixed(4);
        btn.appendChild(gps);
      }
      if (img.location) {
        var pin = document.createElement('span');
        pin.className = 'pin-chip';
        pin.textContent = '📍 ' + img.location.lat.toFixed(4) + ', ' + img.location.lng.toFixed(4);
        btn.appendChild(pin);
      }
      var name = document.createElement('span');
      name.className = 'thumb-name';
      name.textContent = img.name;
      btn.appendChild(name);
      var meta = document.createElement('span');
      meta.className = 'thumb-meta';
      meta.textContent = (img.type.split('/')[1] || 'img').toUpperCase() + ' • ' + formatBytes(img.size);
      btn.appendChild(meta);
      btn.addEventListener('click', function () {
        if (selected.has(img.id)) selected.delete(img.id);
        else selected.add(img.id);
        renderGallery();
        updateUI();
      });
      gallery.appendChild(btn);
    });
  }

  /* ---------- Tagging ---------- */
  function embedGps(dataUrl, lat, lng) {
    var exifObj;
    try { exifObj = piexif.load(dataUrl); }
    catch (e) { exifObj = { '0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null }; }
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = degToDmsRational(lat);
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = degToDmsRational(lng);
    return piexif.insert(piexif.dump(exifObj), dataUrl);
  }

  function stripGps(dataUrl) {
    try {
      var exifObj = piexif.load(dataUrl);
      exifObj.GPS = {};
      return piexif.insert(piexif.dump(exifObj), dataUrl);
    } catch (e) { return dataUrl; }
  }

  function showProgress(text, done, total) {
    $('progressWrap').hidden = false;
    $('progressText').textContent = text;
    $('progressFill').style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
  }
  function hideProgress() { $('progressWrap').hidden = true; $('progressFill').style.width = '0%'; }

  function setBusy(busy) {
    ['tagBtn', 'downloadTaggedBtn', 'downloadZipBtn', 'downloadCsvBtn'].forEach(function (id) {
      $(id).disabled = busy ? true : $(id).disabled;
    });
    if (!busy) updateUI();
  }

  async function tagSelected() {
    if (!selected.size) { showToast('Select at least one image first.', 'error'); return; }
    if (typeof piexif === 'undefined') {
      showToast('EXIF library (piexifjs) failed to load. Check your connection and reload.', 'error');
      return;
    }
    var targets = images.filter(function (img) { return selected.has(img.id); });
    var done = 0, skipped = 0, nonJpeg = 0, results = [];
    setBusy(true);
    for (var i = 0; i < targets.length; i++) {
      var img = targets[i];
      showProgress('Tagging ' + (i + 1) + ' of ' + targets.length + '…', i, targets.length);
      try {
        var isJpeg = img.type === 'image/jpeg' || /\.jpe?g$/i.test(img.name);
        if (img.gpsAction === 'remove') {
          if (isJpeg) {
            img.taggedBlob = dataUrlToBlob(stripGps(await readFileAsDataUrl(img.file)));
          } else { img.taggedBlob = img.file; }
          img.exifApplied = false;
          img.taggedNote = 'GPS removed';
        } else if (img.gpsAction === 'keep' && img.existingGps) {
          img.taggedBlob = img.file;
          img.exifApplied = false;
          img.taggedNote = 'Kept existing GPS ' + coordsText(img.existingGps.lat, img.existingGps.lng);
        } else {
          var loc = mode === 'per' ? img.location : location;
          if (!loc) { skipped++; continue; }
          if (isJpeg) {
            img.taggedBlob = dataUrlToBlob(embedGps(await readFileAsDataUrl(img.file), loc.lat, loc.lng));
            img.exifApplied = true;
            img.taggedNote = 'GPS ' + coordsText(loc.lat, loc.lng);
          } else {
            img.taggedBlob = img.file;
            img.exifApplied = false;
            img.taggedNote = 'PNG/WebP — GPS not embedded';
            nonJpeg++;
          }
        }
        img.tagged = true;
        img.taggedName = taggedFileName(img.name);
        done++;
        results.push(img);
      } catch (err) {
        showToast('Could not tag ' + img.name + ': ' + err.message, 'error');
      }
    }
    hideProgress();
    setBusy(false);
    renderGallery();
    updateUI();
    renderResults(results);
    if (done) showToast(done + ' image(s) tagged.', 'success');
    if (skipped) showToast(skipped + ' image(s) skipped — no location set for them. In "Different per image" mode, tap a photo then tap the map.', 'error');
    if (nonJpeg) showToast('Note: GPS EXIF was applied only to JPEGs. ' + nonJpeg + ' PNG/WebP file(s) will download unchanged, as GPS EXIF is not standard for those formats.', 'error');
  }

  function renderResults(results) {
    var section = $('resultsSection');
    if (!results.length) { section.hidden = true; return; }
    section.hidden = false;
    $('resultsSummary').textContent = results.length + ' tagged. Files are named with a _tagged suffix.';
    var list = $('resultsList');
    list.innerHTML = '';
    results.forEach(function (img) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = img.taggedName + ' — ' + img.taggedNote;
      span.title = img.taggedName;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary';
      btn.textContent = 'Download';
      btn.addEventListener('click', function () { saveBlob(img.taggedBlob, img.taggedName); });
      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  /* ---------- Downloads ---------- */
  function saveBlob(blob, name) {
    if (typeof saveAs === 'function') { saveAs(blob, name); return; }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadTagged() {
    var tagged = images.filter(function (img) { return img.tagged && selected.has(img.id); });
    if (!tagged.length) { showToast('No tagged images selected. Tag some images first.', 'error'); return; }
    tagged.forEach(function (img) { saveBlob(img.taggedBlob, img.taggedName); });
    showToast('Downloading ' + tagged.length + ' tagged image(s).', 'success');
  }

  async function downloadZip() {
    var tagged = images.filter(function (img) { return img.tagged; });
    if (!tagged.length) { showToast('No tagged images yet. Tag some images first.', 'error'); return; }
    if (typeof JSZip === 'undefined') {
      showToast('ZIP library (JSZip) failed to load. Check your connection and reload.', 'error');
      return;
    }
    try {
      showProgress('Making ZIP…', 0, 1);
      var zip = new JSZip();
      tagged.forEach(function (img) { zip.file(img.taggedName, img.taggedBlob); });
      var blob = await zip.generateAsync({ type: 'blob' });
      hideProgress();
      saveBlob(blob, 'geotagged-images.zip');
      showToast('ZIP downloaded with ' + tagged.length + ' tagged image(s).', 'success');
    } catch (err) {
      hideProgress();
      showToast('Could not create the ZIP: ' + err.message, 'error');
    }
  }

  function downloadCsv() {
    var tagged = images.filter(function (img) { return img.tagged; });
    if (!tagged.length) { showToast('No tagged images yet. Tag some images first.', 'error'); return; }
    var rows = [['file', 'latitude', 'longitude', 'place', 'note']];
    tagged.forEach(function (img) {
      var loc = mode === 'per' ? img.location : location;
      var lat = img.existingGps && img.gpsAction === 'keep' ? img.existingGps.lat : (loc ? loc.lat : '');
      var lng = img.existingGps && img.gpsAction === 'keep' ? img.existingGps.lng : (loc ? loc.lng : '');
      var place = loc && loc.place ? loc.place : '';
      var esc = function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; };
      rows.push([esc(img.taggedName), lat, lng, esc(place), esc(img.taggedNote)]);
    });
    var csv = rows.map(function (r) { return r.join(','); }).join('\n');
    saveBlob(new Blob([csv], { type: 'text/csv' }), 'geotagged-list.csv');
    showToast('CSV list downloaded.', 'success');
  }

  function copyCoordinates() {
    var loc = location;
    if (mode === 'per') {
      var first = images.find(function (img) { return selected.has(img.id) && img.location; });
      if (first) loc = first.location;
    }
    if (!loc) { showToast('Pick a location first.', 'error'); return; }
    var text = coordsText(loc.lat, loc.lng);
    function done() { showToast('Copied: ' + text, 'success'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { showToast('Could not copy — select the coordinates manually.', 'error'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { showToast('Could not copy.', 'error'); }
      ta.remove();
    }
  }

  /* ---------- UI state ---------- */
  function locationReady() {
    if (mode === 'same') return !!location;
    return images.some(function (img) { return !!img.location; });
  }

  function setStep(id, state) {
    var el = $(id);
    el.classList.remove('active', 'done', 'locked');
    el.classList.add(state);
    var num = el.querySelector('.step-num');
    num.textContent = state === 'done' ? '✓' : id.replace('step', '');
  }

  function updateUI() {
    $('imageCount').textContent = '(' + images.length + ')';
    var totalSize = images.reduce(function (s, img) { return s + img.size; }, 0);
    var withLoc = images.filter(function (img) { return selected.has(img.id) && img.location; }).length;
    $('selectionInfo').textContent = selected.size
      ? selected.size + ' selected • ' + formatBytes(totalSize) + (mode === 'per' ? ' • ' + withLoc + ' have their own location' : '')
      : 'No images selected';
    $('pngWarning').hidden = !images.some(function (img) { return !/\.jpe?g$/i.test(img.name) && img.type !== 'image/jpeg'; });
    $('actionsEmpty').hidden = images.length > 0;

    // Existing GPS box
    var withGps = images.filter(function (img) { return selected.has(img.id) && img.existingGps; });
    var box = $('existingGpsBox');
    if (withGps.length) {
      box.hidden = false;
      $('existingGpsText').textContent = withGps.length + ' selected photo(s) already have GPS — e.g. ' +
        withGps[0].name + ': ' + coordsText(withGps[0].existingGps.lat, withGps[0].existingGps.lng);
      var action = withGps[0].gpsAction;
      $('gpsKeepBtn').classList.toggle('active', action === 'keep');
      $('gpsReplaceBtn').classList.toggle('active', action === 'replace');
      $('gpsRemoveBtn').classList.toggle('active', action === 'remove');
    } else { box.hidden = true; }

    // Steps
    var taggedCount = images.filter(function (img) { return img.tagged; }).length;
    setStep('step1', images.length ? 'done' : 'active');
    if (!images.length) setStep('step2', 'locked');
    else setStep('step2', locationReady() ? 'done' : 'active');
    if (!images.length || !locationReady()) setStep('step3', 'locked');
    else setStep('step3', taggedCount ? 'done' : 'active');

    // Buttons + why-hints
    var anySelectedHasLoc = images.some(function (img) { return selected.has(img.id) && img.location; });
    var canTag = selected.size > 0 && (mode === 'same' ? !!location : anySelectedHasLoc);
    $('tagBtn').disabled = !canTag;
    $('tagHint').textContent =
      !images.length ? 'Upload photos first.' :
      !selected.size ? 'Select at least one photo.' :
      mode === 'same' && !location ? 'Pick a location first (Step 2).' :
      mode === 'per' && !anySelectedHasLoc ? 'Pick a location for the selected photo(s) — tap a photo, then tap the map.' :
      'Ready — tag ' + selected.size + ' photo(s) in one click.';
    var taggedSelected = images.filter(function (img) { return img.tagged && selected.has(img.id); }).length;
    var canDownload = canTag && taggedSelected > 0;
    $('downloadTaggedBtn').disabled = !canDownload;
    $('downloadHint').textContent = taggedSelected ? 'Ready — download ' + taggedSelected + ' tagged photo(s).' : 'Tag some photos first.';
    var canZip = taggedCount > 0 && locationReady() && images.length > 0;
    $('downloadZipBtn').disabled = !canZip;
    $('zipHint').textContent = taggedCount ? 'Ready — ZIP with ' + taggedCount + ' tagged photo(s).' : 'Tag some photos first.';
    $('downloadCsvBtn').disabled = taggedCount === 0;
    $('csvHint').textContent = taggedCount ? 'Ready — CSV of ' + taggedCount + ' tagged photo(s).' : 'Tag some photos first.';
  }

  function setGpsAction(action) {
    images.forEach(function (img) { if (selected.has(img.id) && img.existingGps) img.gpsAction = action; });
    showToast('Existing GPS: ' + action + ' for selected photos.', 'success');
    updateUI();
  }

  function setMode(next) {
    mode = next;
    $('modeSameBtn').classList.toggle('active', mode === 'same');
    $('modePerBtn').classList.toggle('active', mode === 'per');
    $('modeSameBtn').setAttribute('aria-pressed', mode === 'same' ? 'true' : 'false');
    $('modePerBtn').setAttribute('aria-pressed', mode === 'per' ? 'true' : 'false');
    $('modeHint').textContent = mode === 'same'
      ? 'One location is applied to every selected photo.'
      : 'Tap a photo, then tap the map — that location is saved for that photo only.';
    updateUI();
  }

  /* ---------- Wiring ---------- */
  function init() {
    initMap();
    renderRecent();

    var dropZone = $('dropZone');
    var fileInput = $('fileInput');

    $('uploadBtn').addEventListener('click', function (e) { e.stopPropagation(); fileInput.click(); });
    dropZone.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      fileInput.click();
    });
    dropZone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', function () {
      addFiles(fileInput.files);
      fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) { e.preventDefault(); dropZone.classList.remove('drag-over'); });
    });
    dropZone.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });

    $('selectAllBtn').addEventListener('click', function () {
      images.forEach(function (img) { selected.add(img.id); });
      renderGallery(); updateUI();
    });
    $('deselectAllBtn').addEventListener('click', function () {
      selected.clear();
      renderGallery(); updateUI();
    });
    $('clearAllBtn').addEventListener('click', function () {
      images.forEach(function (img) { URL.revokeObjectURL(img.objectUrl); });
      images = []; selected.clear();
      $('resultsSection').hidden = true;
      renderGallery(); updateUI();
      showToast('All photos cleared.', 'success');
    });

    $('searchBtn').addEventListener('click', searchPlace);
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); searchPlace(); }
    });
    $('myLocationBtn').addEventListener('click', useMyLocation);

    $('modeSameBtn').addEventListener('click', function () { setMode('same'); });
    $('modePerBtn').addEventListener('click', function () { setMode('per'); });

    $('gpsKeepBtn').addEventListener('click', function () { setGpsAction('keep'); });
    $('gpsReplaceBtn').addEventListener('click', function () { setGpsAction('replace'); });
    $('gpsRemoveBtn').addEventListener('click', function () { setGpsAction('remove'); });

    $('setOnMapBtn').addEventListener('click', function () {
      var lat = parseFloat($('latInput').value);
      var lng = parseFloat($('lngInput').value);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        showToast('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).', 'error');
        return;
      }
      setLocation(lat, lng, true, null);
      showToast('Location set on the map.', 'success');
    });
    $('copyCoordsBtn').addEventListener('click', copyCoordinates);

    $('tagBtn').addEventListener('click', tagSelected);
    $('downloadTaggedBtn').addEventListener('click', downloadTagged);
    $('downloadZipBtn').addEventListener('click', downloadZip);
    $('downloadCsvBtn').addEventListener('click', downloadCsv);

    renderGallery();
    updateUI();
  }

  init();
})();
