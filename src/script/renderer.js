
const fs = require( "fs" );
const path = require( "path" );

const PubSub = require( "pubsub-js" );
const Shell = require( "cmjs-shell" );

const {remote, ipcRenderer} = require('electron');
const {Menu, MenuItem, dialog} = remote;

const Splitter = require( "./splitter.js" );
const { Model } = require( "./model.js" );
const editor = require( "./editor.js" );
const { Utils } = require( "./util2.js" );
const PipeR = require( "./piper.js" );
const ProgressBarManager = require( "./progressbar.js" );
const CRAN = require( "./cran.js" );

const Messages = require( "../data/messages.js" ).Main;
const ApplicationMenus = require( "../data/menus.js" );

require( "./resize-events.js" );

let settingsFile = "bert-shell-2-settings.json";
if( process.env.BERT_SHELL_HOME ) settingsFile = path.join( process.env.BERT_SHELL_HOME, settingsFile );

let userStylesheet = "user-stylesheet.css";
if( process.env.BERT_SHELL_HOME ) userStylesheet = path.join( process.env.BERT_SHELL_HOME, userStylesheet );

let R, shell, package;

/**
 * state object so we stop stuffing crap into the global namespace
 */
let state = {
  focused: null,
  shell_size: -1,
  menuEnabledStack: 0, 
  menuCache: null
};

/**
 * settings is an observed proxy backed by a file.  the defaults here 
 * will get overwritten if the file exists.
 */
let settings = Model.createFileStorageProxy({
  layout: { 
    split: [50, 50], 
    direction: Splitter.prototype.Direction.HORIZONTAL 
  }, 
  shell: {
    theme: "dark",
    resize: true
  },
  editor: {
    theme: "vs",
    lineNumbers: true,
    statusBar: true
  }
}, settingsFile, "settings-change" );

window.settings = settings;

let split = new Splitter({ 
  node: document.getElementById("container"), 
  size: settings.layout.split || [50, 50],
  direction: settings.layout.direction || Splitter.prototype.Direction.HORIZONTAL
});

const createMenu = function( template ){
  let menu = new Menu();
  template.forEach( function( item ){
    if( item === "separator" ) menu.append(new MenuItem({type: "separator"}));
    else {
      if( item.setting ){
        if( "value" in item ){ 
          let val = Utils.dereference_get( settings, item.setting );
          item.checked = ( val === item.value );
          item.click = function(item, focusedWindow){ 
            Utils.dereference_set( settings, item.setting, item.value, true ); 
            if( item.id ) PubSub.publish( "menu-click", {id: item.id, focusedWindow: focusedWindow }); 
          }
        }
        else {
          let val = !!Utils.dereference_get( settings, item.setting );
          item.checked = item.invert ? !val : val;
          item.click = function(item, focusedWindow){ 
            Utils.dereference_set( settings, item.setting, item.invert ? !item.checked : item.checked, true ); 
            if( item.id ) PubSub.publish( "menu-click", {id: item.id, focusedWindow: focusedWindow }); 
          }
        }
      }
      else if( item.id ) item.click = function( item, focusedWindow ){ PubSub.publish( "menu-click", {id: item.id, focusedWindow: focusedWindow }); };
      if( item.submenu ) item.submenu = createMenu(item.submenu);
      menu.append(new MenuItem(item));
    }
  });
  return menu;
};

const resizeShell = function(){

  if( !settings.shell || !settings.shell.resize ) return;

  let w = shell.get_width_in_chars();
  if( state.shell_size === w ) return;
  state.shell_size = Math.max( 10, w );
  R.internal( ["set-console-width", state.shell_size], "set-console-width" );

}

/**
 * spinner consolidates operations for showing/hiding and laying out 
 * the spinner; it's in the corner, but offset for scrollbars if they're 
 * showing. maintains its own state.
 * 
 * NOTE that spinner is shown/hidden with opacity, but is always spinning.
 * what does that cost, and can we turn it off?
 * 
 * TODO: have spinner listen for events and update itself
 * 
 */
let spinner = {

  /** create overlay.  don't call this until the shell is in place. */
  init: function(container){

    let overlayNode = document.createElement( "div" );
    overlayNode.className = "overlay-bottom-right status-overlay";
    container.querySelector(".CodeMirror").appendChild( overlayNode ); 

    // cache nodes
    spinner.state = {
      v: document.querySelector(".CodeMirror-vscrollbar"),
      h: document.querySelector(".CodeMirror-hscrollbar"),
      overlay: overlayNode,
      offset_y_installed: true // for side-effect
    };
   
  },

  /** show/hide spinner on busy (show is delayed) */
  set_busy: function(busy){

    // this is the busy/unbusy state.  we show a spinner after some 
    // delay (currently 350ms) which prevents blinking spinners if 
    // internal operations are very slow

    if( !spinner.state ) return;
    if( busy ){
      if( spinner.state.event ) clearTimeout( spinner.state.event );
      spinner.state.event = setTimeout( function(){
        spinner.state.event = undefined;
        spinner.state.overlay.style.opacity=1;
      }, 350 );
    }
    else {

      // FIXME: this is getting called a lot when there's no spinner; 
      // is there a cost?

      if( spinner.state.event ) clearTimeout( spinner.state.event );
      spinner.state.event = undefined;
      spinner.state.overlay.style.opacity=0;
    }

  },

  /** update layout */
  update: function () {

    const adjust_v = function () {

      // we call this here in the event that the function fires twice before 
      // removing the listner; e.g. you clear the console before it ever starts
      // scrolling.  it has no effect if we haven't added yet.
      spinner.state.v.removeEventListener("scroll", adjust_v);

      if (spinner.state.v.clientWidth) {
        spinner.state.overlay.classList.add("scrollbar-offset-x");
      }
      else {
        spinner.state.overlay.classList.remove("scrollbar-offset-x");
        spinner.state.v.addEventListener("scroll", adjust_v);
      }
    };

    const adjust_h = function () {

      let token = 0;

      if (spinner.state.h.clientWidth) {
        spinner.state.overlay.classList.add("scrollbar-offset-y");
        spinner.state.offset_y_installed = true;
        if (token) PubSub.unsubscribe(token);
        token = 0;
      }
      else {
        if (spinner.state.offset_y_installed) {
          spinner.state.overlay.classList.remove("scrollbar-offset-y");
          spinner.state.offset_y_installed = false;
          token = PubSub.subscribe('viewport-change', adjust_h);
        }
      }

    };

    adjust_v();
    adjust_h();

  }

};

const listShellThemes = function(){
  return new Promise( function( resolve, reject ){
    fs.readdir( path.join( __dirname, "../../theme"), function( err, files ){
      let themes = [];    
      if( err ) console.warn(err);
      else {
        themes = files.filter( function( test ){
          return test.match( /\.css$/i );
        }).map( function( file ){
          let p = path.parse( file );
          return p.name;
        }).sort();
        themes.unshift( "default" );
      }
      resolve(themes); // don't reject, just return an empty list
    });
  });
};

const updateShellTheme = function(){

  let theme = "dark";
  if( settings.shell && settings.shell.theme ) theme = settings.shell.theme;

  // remove existing node, if any 
  let oldnode = document.getElementById( "shell-theme-node" );
  if( oldnode ) oldnode.parentElement.removeChild(oldnode);

  if( theme && theme !== "default" )
    Utils.ensureCSS( path.join( __dirname, "../../theme", `${theme}.css` ), { 'data-position': -2, 'id': 'shell-theme-node' }); 

  setTimeout( function(){
    shell.setOption("theme", theme);
    shell.refresh();
  }, 1 );

  Utils.layoutCSS();

};

const updateLayout = function(direction, reset){

  split.setDirection(direction);
  if( reset ){
    split.setVisible(0, true);
    split.setVisible(1, true);
    split.setSizes( 50, 50 );
  }

  editor.layout();
  shell.refresh();
  resizeShell();
  spinner.update();
}

const updateFocusMessage = function(){
  let message;
  if(!(split.visible[0] && split.visible[1] )) message = "";
  else {
    state.focus_message_count = state.focus_message_count || 0;
    let msg = Messages.CHANGE_FOCUS;
    if( state.focus_message_count++ < 8 ) msg = Messages.CHANGE_FOCUS_LONG;
    message = Utils.templateString( msg, state.focused === "editor" ? Messages.EDITOR : Messages.SHELL, 
      Messages.WINDOW_SWITCH_SHORTCUT );
  }
  PubSub.publish( "status-message", message );
};

const updateMenu = function(){

  let template = Utils.clone( ApplicationMenus.Main );  
  let recent = editor.getRecentFiles();

  // let's look this up, as it might move
  let findNode = function(root, id){
    for( let i = 0; i< root.length; i++ ){
      if( root[i].id === id ) return root[i];
      if( root[i].submenu ){
        let tmp = findNode( root[i].submenu, id );
        if( tmp ) return tmp;
      }
    }
  };

  let node = findNode( template, "open-recent" );
  if( node ){
    node.submenu = recent.map( function( elt ){
      return { label: elt, click: function( item ){ 
        PubSub.publish( "menu-click", {id: "open-recent", file: elt });
      }};
    });
  }

  if( package ){
    node = findNode( template, "bert-shell-version" );
    if( node ) node.label += ` ${package.version}`;
  }

  // editor themes
  node = findNode( template, "editor-theme" );
  if( node ){
    node.submenu = editor.getAvailableThemes().map( function( theme ){
      return {
        label: theme, 
        type: "radio",
        setting: "editor.theme",
        value: theme
      };
    });
  }

  // shell themes
  listShellThemes().then( function( themes ){

    node = findNode( template, "shell-theme" );
    if( node ){
      node.submenu = themes.map( function( theme ){
        return {
          label: theme,
          type: "radio",
          setting: "shell.theme",
          // value: theme === "default" ? "" : theme
          value: theme
        }
      });
    }

    Menu.setApplicationMenu(createMenu(template));
  
  });

}

/**
 * enable or disable menu bar (or as close as we can get on electron).
 * disabled state stacks.
 */
PubSub.subscribe( "enable-menu-bar", function( channel, enable ){
  
  if( enable ){
    if( state.menuEnabledStack === 0 ) return;
    state.menuEnabledStack--;
  }
  else state.menuEnabledStack++;

  let menu = Menu.getApplicationMenu();
  if( state.menuEnabledStack === 0 ){
    Menu.setApplicationMenu(state.menuCache);
  }
  else if( state.menuEnabledStack === 1 ){
    state.menuCache = Menu.getApplicationMenu();
    let menu2 = new Menu();
    menu.items.forEach( function( item, index ){
      menu2.insert( index, new MenuItem({ label: item.label, enabled: false }));
    });
    Menu.setApplicationMenu(menu2);
  }

});

PubSub.subscribe( "execute-block", function( channel, code ){
  if( !code.endsWith( "\n" )) code = code + "\n";
  shell.execute_block( code );
});

PubSub.subscribe( "menu-click", function( channel, data ){
  
  if( data ) switch( data.id ){
  case "developer-reload":
    if (data.focusedWindow && settings.developer && settings.developer['allow-reloading']){
      global.allowReload = true; // ??
      data.focusedWindow.reload();
    }
    break;

  case "developer-toggle-tools":
    if (data.focusedWindow) data.focusedWindow.webContents.toggleDevTools();
    break;

  case "open-recent":
    if( data.file ) editor.open( data.file );
    break;

  case "help-learn-more":
    require('electron').shell.openExternal('https://bert-toolkit.com');
    break;

  case "help-feedback":
    require('electron').shell.openExternal('https://bert-toolkit.com/contact');
    break;

  case "help-issues":
    require('electron').shell.openExternal('https://github.com/sdllc/Basic-Excel-R-Toolkit/issues');
    break;

  case "reset-layout":
    split.setSizes( 50, 50 );
    editor.layout();
    PubSub.publish( "splitter-drag" );
    break;

  case "r-packages-choose-mirror":
    CRAN.showMirrorChooser(R, settings);
    break;

  case "r-packages-install-packages":
    CRAN.showPackageChooser(R, settings);
    break;

  case "shell-select-all":
    shell.select_all();
    break;

  case "shell-clear-shell":
    shell.clear();
    spinner.update();
    break;

  default:
    console.info( data );
    break;
  }

});


/**
 * download a file, using electron utilities and optionally adding a 
 * progress bar.  this will get called by the module if download method 
 * is set to "js" (that shoudl be the default IF the console is open).
 */
const download_file = function(opts){
	
	return new Promise( function( resolve, reject ){
		
		let progressbar = null;

		if( !opts.quiet ){
      shell.response( `\n${Messages.TRYING_URL}: ${opts.url}\n` );
      progressbar = {
				label: function(p){
					return ( p >= 100 ) ? Messages.DOWNLOAD_COMPLETE : `${Messages.DOWNLOADING}: ${p}%`;
				}, 
				min: 0, max: 1, value: 0, width: 30, key: "js.download"
      };
      ProgressBarManager.update(progressbar);
		}

		ipcRenderer.on( 'download-progress', function( event, args ){
			if( progressbar ){
				if( progressbar.max === 1 ) progressbar.max = args.total;
				progressbar.value = args.received;
        ProgressBarManager.update(progressbar);
			}
		});

		ipcRenderer.on( 'download-complete', function( event, args ){
      if( progressbar ){
        progressbar.closed = true;
        ProgressBarManager.update(progressbar);
      }
			if( args.state !== "completed" ){
				shell.response( `\n${Messages.DOWNLOAD_FAILED}: ${args.state}\n` );
			}
			ipcRenderer.removeAllListeners( "download-complete" );
			ipcRenderer.removeAllListeners( "download-progress" );
			resolve( args.state === "completed" ? 0 : -1 );
		});
		
  	ipcRenderer.send( "download", opts );
		
	});
		
};

/**
 * consolidating shell callback functions. also hold some state.
 */
const shell_callbacks = {

  tip: function (text, pos) {
    if (settings.shell && settings.shell['hide-function-tips']) return;
    R.internal([ "autocomplete", text, pos ], "autocomplete").then(function (obj) {
      if (obj['signature'])  shell.show_function_tip(obj['signature']);
      else shell.hide_function_tip();
    }).catch(function (e) {

      // generally speaking we can ignore this, although
      // we probably need some filter... for now we will ignore

      // FIXME: debug?
      // console.error(e);

    });
  },

  hint: function (text, pos, callback) {

    // escape both single and double quotes
    text = text.replace(/"/g, "\\\"");
    text = text.replace(/'/g, "\\'");

    R.internal([ "autocomplete", text, pos ], "autocomplete").then(function (obj) {
      if (obj.comps && obj.comps !== "NA") {
        var list = obj.comps;
        if (typeof list === "string") list = list.split(/\n/g ); // [list];
        callback( list, obj.start + 1, obj.end + 1 );
      }
      else callback();
    }).catch(function (obj) { callback(); });

  },

  // FIXME: why keep this here instead of in the state variable
  // (which should represent all state)?

  last_parse_status: Shell.prototype.PARSE_STATUS.OK,

  exec: function( lines, callback ){

    if( !R.initialized ){
      shell.response( "Not connected\n", "shell-error" );
      callback();
      return;
    }
    if( !lines.length ) return;

    if( lines.length === 1 && !lines[0].length 
        && shell_callbacks.last_parse_status === Shell.prototype.PARSE_STATUS.OK ){
      callback();
      return;
    }

    R.exec( lines ).then( function( rslt ){
      shell_callbacks.last_parse_status = Shell.prototype.PARSE_STATUS.OK;
      if( rslt.parsestatus === 2 ){
        rslt.parsestatus = shell_callbacks.last_parse_status = Shell.prototype.PARSE_STATUS.INCOMPLETE;
      }
      callback( rslt );
    }).catch( function( err ){
      console.info( "E", err);
      callback( err );
    })

  }

};

const init_shell = function(container){

  // initialize shell
  container.classList.add( "shell" );
  shell = new Shell(CodeMirror, {
    // debug: true,
    container: container,
    cursorBlinkRate: 0,
    mode: "r",
    hint_function: shell_callbacks.hint,
    tip_function: shell_callbacks.tip,
    exec_function: shell_callbacks.exec,
    //function_key_callback: function_key_callback,
    suppress_initial_prompt: true,
    viewport_change: function () {
      PubSub.publish("viewport-change");
    }
  });

  spinner.init(container);

  // set basic options
  shell.setOption("lineWrapping", (settings.shell && settings.shell.wrap));
  shell.setOption("matchBrackets", true); // fixme: allow user to disable?

  // context menu
  let menu = createMenu( Utils.clone(ApplicationMenus.ShellContext));
  container.addEventListener('contextmenu', function(e){
    e.preventDefault();
    menu.popup(remote.getCurrentWindow());
  }, false);

  // event handlers
  shell.getCM().on( "focus", function(){ PubSub.publish( "focus-event", "shell" );});

}

const init_r = function(){
  
  R = new PipeR();

  // set event handlers

  R.on( "console", function( message, flag ){
    shell.response( message, flag ? "shell-error" : "shell-text" );
  })

  R.on( "control", function( message ){
    if( message === "block" ){ shell.block(); }
    else { shell.unblock(); }
  })

  R.on( "pipe-closed", function(){
    global.__quit =  true;
    remote.getCurrentWindow().close();
  });

  R.on( "state-change", spinner.set_busy );
  
  R.on( "push", function( args ){
    args = args || {};
    if( args.channel === "progress" ){
      let obj = JSON.parse(args.data);
      ProgressBarManager.update(obj.$data);
    }
    else if( args.channel === "download" ){
      let obj = JSON.parse(args.data);
      download_file(obj.$data).then( function( result ){
        R.internal([ "sync-response", result ]);
      }).catch( function( err ){
        console.error( "download error", err );
        R.internal([ "sync-response", -1 ]);
      })
    }
  });

  // attach to pipe

  let pipename = process.env.BERT_PIPE_NAME;

  if( pipename ){ 
    R.init({ pipename: pipename });

    window.addEventListener("beforeunload", function (event) {
      if( global.__quit || global.allowReload ) return;
      event.returnValue = false;
      R.internal( ["hide"], "hide" );
    });

  }
  else {
    Notifier.notify({
      title: Messages.WARNING,
      className: "warning",
      body: Messages.NOT_CONNECTED,
      timeout: 9,
      footer: Messages.OK
    });
    global.__quit = true;
  }

}

// read package.json

fs.readFile( path.join( __dirname, "../../package.json" ), function( err, data ){
  if( err ) console.error( "ERR reading package.json", err );
  else {
    package = JSON.parse( data );
    PubSub.publish( "update-menu" );
  }
})

// user stylesheet

Utils.ensureCSS( userStylesheet, { "data-position": -1 });

// initialize editor, shell, R connection

let editorOptions = Utils.clone(settings.editor || {}); // fixme: defaults here?

editor.init( split.panes[0], editorOptions ).then( function(){
  Utils.layoutCSS();
})

init_shell( split.panes[1] );
init_r();

///////////

window.addEventListener( "keydown", function(e){
  if( e.ctrlKey ){
    if( e.code === "PageUp" ){
      e.stopPropagation();
      e.preventDefault();
      editor.selectTab({ delta: -1 });
    }
    else if( e.code === "PageDown" ){
      e.stopPropagation();
      e.preventDefault();
      editor.selectTab({ delta: 1 });
    }
    else if( e.code === "KeyE" && !e.shiftKey ){
      e.stopPropagation();
      e.preventDefault();
      if( state.focused === "editor" ) shell.focus();
      else editor.focus();
    }
    else if( e.code === "F8" ){
      e.stopPropagation();
      e.preventDefault();
      shell.clear();
      spinner.update();
    }
    // else console.info( e.code );
    return;
  }
});

PubSub.subscribe( "update-menu", function( channel, data ){
  updateMenu();
});

PubSub.subscribe( "focus-event", function( channel, owner ){
  state.focused = owner;
  updateFocusMessage();
});

PubSub.subscribe( "splitter-drag", function(channel, data){
  PubSub.publish( "status-message", `Layout: ${split.panes[0].style.width} / ${split.panes[1].style.width}` );
});

PubSub.subscribe( "window-resize", function(channel, data){
  resizeShell();
  shell.refresh();
  spinner.update();    
});

/** only on drag end do we update settings */
PubSub.subscribe( "splitter-resize", function(channel, data){
  settings.layout = { split: [ 
    Number( split.panes[0].style.width.replace( /[^\d\.]/g, "" )),
    Number( split.panes[1].style.width.replace( /[^\d\.]/g, "" ))] };

  resizeShell();
  shell.refresh();
  spinner.update();    

});

PubSub.subscribe( "settings-change", function( channel, data ){
  switch( data[0] ){

  case "shell.theme":
    updateShellTheme();
    return;

  case "layout.direction":
    updateLayout( settings.layout.direction, true  );
    return;

  case "shell.hide":
    split.setVisible( 1, !settings.shell.hide );
    if( !settings.shell.hide ) shell.refresh();
    updateFocusMessage();
    resizeShell();
    editor.layout();
    spinner.update();
    return;

  case "editor.hide":
    split.setVisible( 0, !settings.editor.hide );
    if( !settings.editor.hide ) editor.layout();
    updateFocusMessage();
    resizeShell();
    editor.layout();
    spinner.update();
    return;

  }

  let m = data[0].match( /editor\.(.*)$/ );
  if( m ){
    let opts = {};
    opts[m[1]] = Utils.dereference_get( settings, data[0] );
    editor.updateOptions(opts);
    Utils.layoutCSS(); // in case the editor monkeys around with it
    return;
  }

  console.info( data );

});

if( settings.editor && settings.editor.hide ) split.setVisible( 0, false );
if( settings.shell && settings.shell.hide ) split.setVisible( 1, false );


updateShellTheme();

// menu 
updateMenu();
ProgressBarManager.init(shell);
spinner.update();