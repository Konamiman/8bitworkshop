"use strict";

// 8bitworkshop IDE user interface

import $ = require("jquery");
import * as bootstrap from "bootstrap";
import { CodeProject } from "./project";
import { WorkerResult, SourceFile } from "./workertypes";
import { ProjectWindows } from "./windows";
import { Platform, Preset } from "./baseplatform";
import * as Views from "./views";

// external libs (TODO)
declare var Octokat, ga, Tour, GIF, saveAs;
declare function createNewPersistentStore(platform_id : string);
declare function showLoopTimingForPC(pc:number, sourcefile:SourceFile, wnd:Views.ProjectView);
// loaded by platform js file
declare var PLATFORMS;

// make sure VCS doesn't start
if (window['Javatari']) window['Javatari'].AUTO_START = false;

var PRESETS : Preset[];		// presets array
var platform_id : string;	// platform ID string
var platform : Platform;	// platform object

var toolbar = $("#controls_top");

var current_project : CodeProject;	// current CodeProject object

var projectWindows : ProjectWindows;	// window manager


// TODO: codemirror multiplex support?
var TOOL_TO_SOURCE_STYLE = {
  'dasm': '6502',
  'acme': '6502',
  'cc65': 'text/x-csrc',
  'ca65': '6502',
  'z80asm': 'z80',
  'sdasz80': 'z80',
  'sdcc': 'text/x-csrc',
  'verilator': 'verilog',
  'jsasm': 'z80'
}

function newWorker() : Worker {
  return new Worker("./src/worker/workermain.js");
}

var userPaused : boolean;		// did user explicitly pause?

var current_output;			// current ROM
var current_preset_entry : Preset;	// current preset object (if selected)
var main_file_id : string;	// main file ID
var symbolmap;			// symbol map
var addr2symbol;		// address to symbol name map
var compparams;			// received build params from worker
var store;			// persistent store

var lastDebugInfo;		// last debug info (CPU text)
var lastDebugState;		// last debug state (object)

function inspectVariable(ed, name) { // TODO: ed?
  var val;
  if (platform.inspect) {
    platform.inspect(name);
  }
}

function getCurrentPresetTitle() : string {
  if (!current_preset_entry)
    return "ROM";
  else
    return current_preset_entry.title || current_preset_entry.name || "ROM";
}

function setLastPreset(id:string) {
  if (platform_id != 'base_z80') { // TODO
    localStorage.setItem("__lastplatform", platform_id);
    localStorage.setItem("__lastid_"+platform_id, id);
  }
}

function initProject() {
  current_project = new CodeProject(newWorker(), platform_id, platform, store);
  projectWindows = new ProjectWindows($("#workspace")[0], current_project);
  current_project.callbackGetRemote = $.get;
  current_project.callbackBuildResult = (result:WorkerResult) => {
    setCompileOutput(result);
    refreshWindowList();
  };
  current_project.callbackBuildStatus = (busy:boolean) => {
    if (busy) {
      toolbar.addClass("is-busy");
    } else {
      toolbar.removeClass("is-busy");
      toolbar.removeClass("has-errors"); // may be added in next callback
      projectWindows.setErrors(null);
    }
    $('#compile_spinner').css('visibility', busy ? 'visible' : 'hidden');
  };
}

function refreshWindowList() {
  var ul = $("#windowMenuList").empty();
  var separate = false;
  
  function addWindowItem(id, name, createfn) {
    if (separate) {
      ul.append(document.createElement("hr"));
      separate = false;
    }
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.setAttribute("class", "dropdown-item");
    a.setAttribute("href", "#");
    a.appendChild(document.createTextNode(name));
    li.appendChild(a);
    ul.append(li);
    if (createfn) {
      projectWindows.setCreateFunc(id, createfn);
      $(a).click(function(e) {
        projectWindows.createOrShow(id);
        ul.find('a').removeClass("dropdown-item-checked");
        ul.find(e.target).addClass("dropdown-item-checked");
      });
    }
  }
  
  function loadEditor(path:string) {
    var tool = platform.getToolForFilename(path);
    var mode = tool && TOOL_TO_SOURCE_STYLE[tool];
    return new Views.SourceEditor(path, mode);
  }
  
  // add main file editor
  var id = main_file_id;
  addWindowItem(id, getFilenameForPath(id), loadEditor);
  
  // add other source files
  separate = true;
  current_project.iterateFiles(function(id, text) {
    if (id != main_file_id)
      addWindowItem(id, getFilenameForPath(id), loadEditor);
  });
  
  // add listings
  var listings = current_project.getListings();
  if (listings) {
    for (var lstfn in listings) {
      var lst = listings[lstfn];
      if (lst.assemblyfile) {
        addWindowItem(lstfn, getFilenameForPath(lstfn), function(path) {
          return new Views.ListingView(lst.assemblyfile);
        });
      }
    }
  }

  // add other tools
  separate = true;
  if (platform.disassemble) {
    addWindowItem("#disasm", "Disassembly", function() {
      return new Views.DisassemblerView();
    });
  }
  if (platform.readAddress && platform_id != 'vcs') {
    addWindowItem("#memory", "Memory Browser", function() {
      return new Views.MemoryView();
    });
  }
}

// can pass integer or string id
function loadProject(preset_id:string) {
  var index = parseInt(preset_id+""); // might fail -1
  for (var i=0; i<PRESETS.length; i++)
    if (PRESETS[i].id == preset_id)
      index = i;
  index = (index + PRESETS.length) % PRESETS.length;
  if (index >= 0) {
    // load the preset
    current_preset_entry = PRESETS[index];
    preset_id = current_preset_entry.id;
  }
  // set current file ID
  main_file_id = preset_id;
  setLastPreset(preset_id);
  current_project.mainPath = preset_id;
  // load files from storage or web URLs
  current_project.loadFiles([preset_id], function(err, result) {
    if (err) {
      alert(err);
    } else if (result && result.length) {
      // we need this to build create functions for the editor (TODO?)
      refreshWindowList();
      // show main file
      projectWindows.createOrShow(preset_id); // TODO: add checkmark
    }
  });
}

function reloadPresetNamed(id:string) {
  qs['platform'] = platform_id;
  qs['file'] = id;
  gotoNewLocation();
}

function getSkeletonFile(fileid:string, callback) {
  var ext = platform.getToolForFilename(fileid);
  $.get( "presets/"+platform_id+"/skeleton."+ext, function( text ) {
    callback(null, text);
  }, 'text')
  .fail(function() {
    alert("Could not load skeleton for " + platform_id + "/" + ext + "; using blank file");
    callback(null, '\n');
  });
}

function _createNewFile(e) {
  var filename = prompt("Create New File", "newfile" + platform.getDefaultExtension());
  if (filename && filename.length) {
    if (filename.indexOf(".") < 0) {
      filename += platform.getDefaultExtension();
    }
    var path = "local/" + filename;
    getSkeletonFile(path, function(err, result) {
      if (result) {
        store.setItem(path, result, function(err, result) {
          if (err)
            alert(err+"");
          if (result != null)
            reloadPresetNamed("local/" + filename);
        });
      }
    });
  }
  return true;
}

function _uploadNewFile(e) {
  $("#uploadFileElem").click();
}

function handleFileUpload(files: File[]) {
  console.log(files);
  var index = 0;
  function uploadNextFile() { 
    var f = files[index++];
    if (!f) {
      console.log("Done uploading");
      gotoNewLocation();
    } else {
      var path = "local/" + f.name;
      var reader = new FileReader();
      reader.onload = function(e) {
        var data = e.target.result;
        store.setItem(path, data, function(err, result) {
          if (err)
            console.log(err);
          else {
            console.log("Uploaded " + path + " " + data.length + " bytes");
            if (index == 1)
              qs['file'] = path;
            uploadNextFile();
          }
        });
      }
      reader.readAsText(f);
    }
  }
  if (files) uploadNextFile();
}

function getCurrentFilename() : string {
  var toks = main_file_id.split("/");
  return toks[toks.length-1];
}

function _shareFile(e) {
  if (current_output == null) { // TODO
    alert("Please fix errors before sharing.");
    return true;
  }
  var text = projectWindows.getCurrentText();
  if (!text) return false;
  var github = new Octokat();
  var files = {};
  files[getCurrentFilename()] = {"content": text};
  var gistdata = {
    "description": '8bitworkshop.com {"platform":"' + platform_id + '"}',
    "public": true,
    "files": files
  };
  var gist = github.gists.create(gistdata).done(function(val) {
    var url = "http://8bitworkshop.com/?sharekey=" + val.id;
    window.prompt("Copy link to clipboard (Ctrl+C, Enter)", url);
  }).fail(function(err) {
    alert("Error sharing file: " + err.message);
  });
  return true;
}

function _resetPreset(e) {
  if (!current_preset_entry) {
    alert("Can only reset built-in file examples.")
  } else if (confirm("Reset '" + current_preset_entry.name + "' to default?")) {
    qs['reset'] = '1';
    gotoNewLocation();
  }
  return true;
}

function _downloadROMImage(e) {
  if (current_output == null) { // TODO
    alert("Please fix errors before downloading ROM.");
    return true;
  }
  var blob = new Blob([current_output], {type: "application/octet-stream"});
  saveAs(blob, getCurrentFilename()+".rom");
}

function _downloadSourceFile(e) {
  var text = projectWindows.getCurrentText();
  if (!text) return false;
  var blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  saveAs(blob, getCurrentFilename());
}

function populateExamples(sel) {
  // make sure to use callback so it follows other sections
  store.length(function(err, len) {
    sel.append($("<option />").text("--------- Examples ---------").attr('disabled','true'));
    for (var i=0; i<PRESETS.length; i++) {
      var preset = PRESETS[i];
      var name = preset.chapter ? (preset.chapter + ". " + preset.name) : preset.name;
      sel.append($("<option />").val(preset.id).text(name).attr('selected',(preset.id==main_file_id)?'selected':null));
    }
  });
}

function populateFiles(sel, category, prefix) {
  store.keys(function(err, keys : string[]) {
    var foundSelected = false;
    var numFound = 0;
    if (!keys) keys = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.startsWith(prefix)) {
        if (numFound++ == 0)
          sel.append($("<option />").text("------- " + category + " -------").attr('disabled','true'));
        var name = key.substring(prefix.length);
        sel.append($("<option />").val(key).text(name).attr('selected',(key==main_file_id)?'selected':null));
        if (key == main_file_id) foundSelected = true;
      }
    }
    if (!foundSelected && main_file_id && main_file_id.startsWith(prefix)) {
      var name = main_file_id.substring(prefix.length);
      var key = prefix + name;
      sel.append($("<option />").val(key).text(name).attr('selected','true'));
    }
  });
}

function updateSelector() {
  var sel = $("#preset_select").empty();
  if (platform_id != 'base_z80') { // TODO
    populateFiles(sel, "Local Files", "local/");
    populateFiles(sel, "Shared", "shared/");
  }
  populateExamples(sel);
  // set click handlers
  sel.off('change').change(function(e) {
    reloadPresetNamed($(this).val());
  });
}

function setCompileOutput(data: WorkerResult) {
  // errors? mark them in editor
  if (data.errors && data.errors.length > 0) {
    projectWindows.setErrors(data.errors);
    toolbar.addClass("has-errors");
  } else {
    // process symbol map
    symbolmap = data.symbolmap;
    addr2symbol = invertMap(symbolmap);
    if (!addr2symbol[0x0]) addr2symbol[0x0] = '__START__'; // needed for ...
    addr2symbol[0x10000] = '__END__'; // needed for dump memory to work
    compparams = data.params;
    // load ROM
    var rom = data.output;
    if (rom) { // TODO instanceof Uint8Array) {
      try {
        //console.log("Loading ROM length", rom.length);
        platform.loadROM(getCurrentPresetTitle(), rom);
        if (!userPaused) resume();
        current_output = rom;
        //resetProfiler();
      } catch (e) {
        console.log(e);
        toolbar.addClass("has-errors");
        projectWindows.setErrors([{line:0,msg:e+""}]);
        current_output = null;
      }
    /* TODO?
    } else if (rom.program_rom_variable) { //TODO: a little wonky...
      platform.loadROM(rom.program_rom_variable, rom.program_rom);
    */
    }
    // update all windows (listings)
    projectWindows.refresh();
  }
}

function showMemory(state?) {
  var s = state && platform.cpuStateToLongString && platform.cpuStateToLongString(state.c);
  if (s) {
    if (platform.getRasterPosition) {
      var pos = platform.getRasterPosition();
      s += "H:" + pos.x + "  V:" + pos.y + "\n"; // TODO: padding
    }
    if (platform.ramStateToLongString) {
      s += platform.ramStateToLongString(state);
    }
    var hs = lastDebugInfo ? highlightDifferences(lastDebugInfo, s) : s;
    $("#mem_info").show().html(hs);
    lastDebugInfo = s;
  } else {
    $("#mem_info").hide();
    lastDebugInfo = null;
  }
}

function setDebugButtonState(btnid:string, btnstate:string) {
  $("#debug_bar").find("button").removeClass("btn_active").removeClass("btn_stopped");
  $("#dbg_"+btnid).addClass("btn_"+btnstate);
}

function setupBreakpoint(btnid? : string) {
  platform.setupDebug(function(state) {
    lastDebugState = state;
    showMemory(state);
    projectWindows.refresh();
    if (btnid) setDebugButtonState(btnid, "stopped");
  });
  if (btnid) setDebugButtonState(btnid, "active");
}

function _pause() {
  if (platform.isRunning()) {
    platform.pause();
    console.log("Paused");
  }
  setDebugButtonState("pause", "stopped");
}

function pause() {
  clearBreakpoint();
  _pause();
  userPaused = true;
}

function _resume() {
  if (! platform.isRunning()) {
    platform.resume();
    console.log("Resumed");
  }
  setDebugButtonState("go", "active");
}

function resume() {
  clearBreakpoint();
  if (! platform.isRunning() ) {
    projectWindows.refresh();
  }
  _resume();
  userPaused = false;
}

function singleStep() {
  setupBreakpoint("step");
  platform.step();
}

function singleFrameStep() {
  setupBreakpoint("tovsync");
  platform.runToVsync();
}

function getEditorPC() : number {
  var wnd = projectWindows.getActive();
  return wnd && wnd.getCursorPC && wnd.getCursorPC();
}

function runToCursor() {
  setupBreakpoint("toline");
  var pc = getEditorPC();
  if (pc >= 0) {
    console.log("Run to", pc.toString(16));
    if (platform.runToPC) {
      platform.runToPC(pc);
    } else {
      platform.runEval(function(c) {
        return c.PC == pc;
      });
    }
  }
}

function runUntilReturn() {
  setupBreakpoint("stepout");
  platform.runUntilReturn();
}

function runStepBackwards() {
  setupBreakpoint("stepback");
  platform.stepBack();
}

function clearBreakpoint() {
  lastDebugState = null;
  if (platform.clearDebug) platform.clearDebug();
  showMemory();
}

function resetAndDebug() {
  if (platform.setupDebug && platform.readAddress) { // TODO??
    clearBreakpoint();
    _resume();
    platform.reset();
    setupBreakpoint("reset");
    if (platform.runEval)
      platform.runEval(function(c) { return true; }); // break immediately
    else
      ; // TODO???
  } else {
    platform.reset();
  }
}

var lastBreakExpr = "c.PC == 0x6000";
function _breakExpression() {
  var exprs = window.prompt("Enter break expression", lastBreakExpr);
  if (exprs) {
    var fn = new Function('c', 'return (' + exprs + ');');
    setupBreakpoint();
    platform.runEval(fn);
    lastBreakExpr = exprs;
  }
}

function getSymbolAtAddress(a : number) {
  if (addr2symbol[a]) return addr2symbol[a];
  var i=0;
  while (--a >= 0) {
    i++;
    if (addr2symbol[a]) return addr2symbol[a] + '+' + i;
  }
  return '';
}

function updateDebugWindows() {
  if (platform.isRunning()) {
    projectWindows.tick();
  }
  setTimeout(updateDebugWindows, 200);
}

function _recordVideo() {
  var canvas = $("#emulator").find("canvas")[0];
  if (!canvas) {
    alert("Could not find canvas element to record video!");
    return;
  }
  var rotate = 0;
  if (canvas.style && canvas.style.transform) {
    if (canvas.style.transform.indexOf("rotate(-90deg)") >= 0)
      rotate = -1;
    else if (canvas.style.transform.indexOf("rotate(90deg)") >= 0)
      rotate = 1;
  }
  var gif = new GIF({
    workerScript: 'gif.js/dist/gif.worker.js',
    workers: 4,
    quality: 10,
    rotate: rotate
  });
  var img = $('#videoPreviewImage');
  //img.attr('src', 'https://articulate-heroes.s3.amazonaws.com/uploads/rte/kgrtehja_DancingBannana.gif');
  gif.on('finished', function(blob) {
    img.attr('src', URL.createObjectURL(blob));
    $("#pleaseWaitModal").modal('hide');
    _resume();
    $("#videoPreviewModal").modal('show');
  });
  var intervalMsec = 17;
  var maxFrames = 500;
  var nframes = 0;
  console.log("Recording video", canvas);
  var f = function() {
    if (nframes++ > maxFrames) {
      console.log("Rendering video");
      $("#pleaseWaitModal").modal('show');
      _pause();
      gif.render();
    } else {
      gif.addFrame(canvas, {delay: intervalMsec, copy: true});
      setTimeout(f, intervalMsec);
    }
  };
  f();
}

function setFrameRateUI(fps:number) {
  platform.setFrameRate(fps);
  if (fps > 0.01)
    $("#fps_label").text(fps.toFixed(2));
  else
    $("#fps_label").text("1/"+Math.round(1/fps));
}

function _slowerFrameRate() {
  var fps = platform.getFrameRate();
  fps = fps/2;
  if (fps > 0.00001) setFrameRateUI(fps);
}

function _fasterFrameRate() {
  var fps = platform.getFrameRate();
  fps = Math.min(60, fps*2);
  setFrameRateUI(fps);
}

function _slowestFrameRate() {
  setFrameRateUI(60/65536);
}

function _fastestFrameRate() {
  _resume();
  setFrameRateUI(60);
}

function _openBitmapEditor() {
  var wnd = projectWindows.getActive();
  if (wnd && wnd.openBitmapEditorAtCursor)
    wnd.openBitmapEditorAtCursor();
}

function traceTiming() {
  projectWindows.refresh();
  var wnd = projectWindows.getActive();
  if (wnd.getSourceFile && wnd.setGutterBytes) { // is editor active?
    showLoopTimingForPC(0, wnd.getSourceFile(), wnd);
  }
}

function setupDebugControls(){
  $("#dbg_reset").click(resetAndDebug);
  $("#dbg_pause").click(pause);
  $("#dbg_go").click(resume);

  if (platform.step)
    $("#dbg_step").click(singleStep).show();
  else
    $("#dbg_step").hide();
  if (platform.runToVsync)
    $("#dbg_tovsync").click(singleFrameStep).show();
  else
    $("#dbg_tovsync").hide();
  if ((platform.runEval || platform.runToPC) && platform_id != 'verilog')
    $("#dbg_toline").click(runToCursor).show();
  else
    $("#dbg_toline").hide();
  if (platform.runUntilReturn)
    $("#dbg_stepout").click(runUntilReturn).show();
  else
    $("#dbg_stepout").hide();
  if (platform.stepBack)
    $("#dbg_stepback").click(runStepBackwards).show();
  else
    $("#dbg_stepback").hide();

  if (window['showLoopTimingForPC']) { // VCS-only (TODO: put in platform)
    $("#dbg_timing").click(traceTiming).show();
  }
  $("#disassembly").hide();
  $("#dbg_bitmap").click(_openBitmapEditor);
  $(".dropdown-menu").collapse({toggle: false});
  $("#item_new_file").click(_createNewFile);
  $("#item_upload_file").click(_uploadNewFile);
  $("#item_share_file").click(_shareFile);
  $("#item_reset_file").click(_resetPreset);
  if (platform.runEval)
    $("#item_debug_expr").click(_breakExpression).show();
  else
    $("#item_debug_expr").hide();
  $("#item_download_rom").click(_downloadROMImage);
  $("#item_download_file").click(_downloadSourceFile);
  $("#item_record_video").click(_recordVideo);
  if (platform.setFrameRate && platform.getFrameRate) {
    $("#speed_bar").show();
    $("#dbg_slower").click(_slowerFrameRate);
    $("#dbg_faster").click(_fasterFrameRate);
    $("#dbg_slowest").click(_slowestFrameRate);
    $("#dbg_fastest").click(_fastestFrameRate);
  }
  updateDebugWindows();
}

function showWelcomeMessage() {
  if (!localStorage.getItem("8bitworkshop.hello")) {
    // Instance the tour
    var is_vcs = platform_id == 'vcs';
    var steps = [
        {
          element: "#workspace",
          title: "Welcome to 8bitworkshop!",
          content: is_vcs ? "Type your 6502 assembly code into the editor, and it'll be assembled in real-time. All changes are saved to browser local storage."
                          : "Type your source code into the editor, and it'll be compiled in real-time. All changes are saved to browser local storage."
        },
        {
          element: "#emulator",
          placement: 'left',
          title: "Emulator",
          content: "This is an emulator for the \"" + platform_id + "\" platform. We'll load your compiled code into the emulator whenever you make changes."
        },
        {
          element: "#preset_select",
          title: "File Selector",
          content: "Pick a code example from the book, or access your own files and files shared by others."
        },
        {
          element: "#debug_bar",
          placement: 'bottom',
          title: "Debug Tools",
          content: "Use these buttons to set breakpoints, single step through code, pause/resume, and use debugging tools."
        },
        {
          element: "#dropdownMenuButton",
          title: "Main Menu",
          content: "Click the menu to switch between platforms, create new files, or share your work with others."
        }];
    if (!is_vcs) {
      steps.push({
        element: "#windowMenuButton",
        title: "Window List",
        content: "Switch between editor windows, assembly listings, and other tools like disassembler and memory dump."
      });
    }
    steps.push({
      element: "#booksMenuButton",
      placement: 'left',
      title: "Bookstore",
      content: "Get some books that explain how to program all of this stuff!"
    });
    var tour = new Tour({
      autoscroll:false,
      //storage:false,
      steps:steps
    });
    tour.init();
    setTimeout(function() { tour.start(); }, 2000);
  }
}

///////////////////////////////////////////////////

var qs = (function (a : string[]) {
    if (!a || a.length == 0)
        return {};
    var b = {};
    for (var i = 0; i < a.length; ++i) {
        var p = a[i].split('=', 2);
        if (p.length == 1)
            b[p[0]] = "";
        else
            b[p[0]] = decodeURIComponent(p[1].replace(/\+/g, " "));
    }
    return b;
})(window.location.search.substr(1).split('&'));

// catch errors
function installErrorHandler() {
  if (typeof window.onerror == "object") {
      window.onerror = function (msgevent, url, line, col, error) {
        console.log(msgevent, url, line, col);
        console.log(error);
        ga('send', 'exception', {
          'exDescription': msgevent + " " + url + " " + " " + line + ":" + col + ", " + error,
          'exFatal': true
        });
        alert(msgevent+"");
      };
  }
}

function uninstallErrorHandler() {
  window.onerror = null;
}

function gotoNewLocation() {
  uninstallErrorHandler();
  window.location.href = "?" + $.param(qs);
}

function initPlatform() {
  store = createNewPersistentStore(platform_id);
}

function showBookLink() {
  if (platform_id == 'vcs')
    $("#booklink_vcs").show();
  else if (platform_id == 'mw8080bw' || platform_id == 'vicdual' || platform_id == 'galaxian-scramble' || platform_id == 'vector-z80color' || platform_id == 'williams-z80')
    $("#booklink_arcade").show();
}

function addPageFocusHandlers() {
  var hidden = false;
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState == 'hidden' && platform.isRunning()) {
      _pause();
      hidden = true;
    } else if (document.visibilityState == 'visible' && hidden) {
      _resume();
      hidden = false;
    }
  });
  $(window).on("focus", function() {
    if (hidden) {
      _resume();
      hidden = false;
    }
  });
  $(window).on("blur", function() {
    if (platform.isRunning()) {
      _pause();
      hidden = true;
    }
  });
}

function startPlatform() {
  initPlatform();
  if (!PLATFORMS[platform_id]) throw Error("Invalid platform '" + platform_id + "'.");
  platform = new PLATFORMS[platform_id]($("#emulator")[0]);
  PRESETS = platform.getPresets();
  if (qs['file']) {
    // start platform and load file
    platform.start();
    setupDebugControls();
    initProject();
    loadProject(qs['file']);
    updateSelector();
    showBookLink();
    addPageFocusHandlers();
    return true;
  } else {
    // try to load last file (redirect)
    var lastid = localStorage.getItem("__lastid_"+platform_id) || localStorage.getItem("__lastid");
    localStorage.removeItem("__lastid");
    reloadPresetNamed(lastid || PRESETS[0].id);
    return false;
  }
}

function loadSharedFile(sharekey : string) {
  var github = new Octokat();
  var gist = github.gists(sharekey);
  gist.fetch().done(function(val) {
    var filename;
    for (filename in val.files) { break; }
    var newid = 'shared/' + filename;
    var json = JSON.parse(val.description.slice(val.description.indexOf(' ')+1));
    console.log("Fetched " + newid, json);
    platform_id = json['platform'];
    initPlatform();
    current_project.updateFile(newid, val.files[filename].content);
    reloadPresetNamed(newid);
    delete qs['sharekey'];
    gotoNewLocation();
  }).fail(function(err) {
    alert("Error loading share file: " + err.message);
  });
  return true;
}

// start
function startUI(loadplatform : boolean) {
  installErrorHandler();
  // add default platform?
  platform_id = qs['platform'] || localStorage.getItem("__lastplatform");
  if (!platform_id) {
    platform_id = qs['platform'] = "vcs";
  }
  $("#item_platform_"+platform_id).addClass("dropdown-item-checked");
  // parse query string
  // is this a share URL?
  if (qs['sharekey']) {
    loadSharedFile(qs['sharekey']);
  } else {
    // reset file?
    if (qs['file'] && qs['reset']) {
      initPlatform();
      store.removeItem(qs['file']);
      qs['reset'] = '';
      gotoNewLocation();
    } else {
      // load and start platform object
      if (loadplatform) {
        var scriptfn = 'src/platform/' + platform_id.split('-')[0] + '.js';
        var script = document.createElement('script');
        script.onload = function() {
          console.log("loaded platform", platform_id);
          startPlatform();
          showWelcomeMessage();
        };
        script.src = scriptfn;
        document.getElementsByTagName('head')[0].appendChild(script);
      } else {
        startPlatform();
        showWelcomeMessage();
      }
    }
  }
}
