
"use strict";

const fs = require( "fs" );
const path = require( "path" );

const PubSub = require( "pubsub-js" );

const Cache = require( "./cache.js" );
const HTMLDialog = require( "./dialog.js" );
const Messages = require( "../data/messages.js" ).Main;
const { Utils } = require( "./util2.js" );
const VList = require( "./vlist.js" );

// 4 hours for dev, 0 (session) for production
// const CRAN_CACHE_TIME = 0 ; // session 
const CRAN_CACHE_TIME = 60 * 60 * 4; 

let sessionCache = {};

const getTemplate = function(f){
  return new Promise( function( resolve, reject ){
    if( sessionCache[f] ) return resolve(sessionCache[f]);
    Utils.readFile(f).then( function(data){
      sessionCache[f] = data;
      resolve(data);
    }).catch(function(err){
      reject(err);
    })
  })
}


/**
 * if we have a good CRAN repo, start the package chooser.
 * note we're caching packages according to the repo, but we don't 
 * want to hold a lot of these unecessarily. 
 * 
 * FIXME: session storage
 */
const showPackageChooserInternal = function(R, settings, cran){

  getTemplate( path.join( __dirname, "..", "data/package-chooser.template.html" )).then( function(template){

    let vlist;
    let currentFilter = "";
    let chooser = new HTMLDialog(template, Messages);
    let cacheKey = "package-list-" + cran;
    let data = Cache.get( cacheKey );
    let filtered;
    let selected_count = 0;

    // start with "please wait"
    chooser.nodes['package-chooser-wait'].style.display = "block";
    chooser.nodes['package-chooser-list'].style.display = "none";
    chooser.nodes['dialog-footer-status-message'].textContent = "";

    // data filter function 
    let filterData = function(){
      if( !currentFilter || currentFilter.trim() === "" ){
        filtered = data;
      }
      else {
        let rex = new RegExp(currentFilter, "i");
        filtered = [];
        for( let i = 0; i< data.length; i++ ){
          if( data[i][0].match( rex )){
            filtered.push( data[i] );
          }
        }
      }
    };

    // update the filter, update or potentially create the list 
    let updateFilter = function(){
      let f = (chooser.nodes['package-chooser-filter'].value || "").trim();
      if( !vlist || ( currentFilter !== f )){
        currentFilter = f;
        filterData();
        if(!vlist) vlist = new VList( chooser.nodes['package-chooser-list'], filtered, nodetemplate, update );
        else vlist.updateData( filtered );
      }
    };
    chooser.nodes['package-chooser-filter'].addEventListener( "input", updateFilter );

    // element click 
    let click = function(e){
      let n = e.target;
      while( n && n.parentNode && n.className !== "vlist-list-entry" ){
        n = n.parentNode;
      }
      if( n.className !== "vlist-list-entry" ) return null;
      let data = n.data;
      if( data.installed ) return; // can't toggle

      data.selected = !data.selected;
      vlist.repaint();

      if( data.selected ) selected_count++;
      else selected_count--;

      if( selected_count === 0 )
        chooser.nodes['dialog-footer-status-message'].textContent = "";
      else if( selected_count === 1 )
        chooser.nodes['dialog-footer-status-message'].textContent = `1 ${Messages.PACKAGE_SELECTED_SINGLE}`;
      else
        chooser.nodes['dialog-footer-status-message'].textContent = `${selected_count} ${Messages.PACKAGE_SELECTED_PLURAL}`;


      // console.info( "index", n.index, "data", n.data );
    };

    // vlist update function 
    let update = function( node, data, index ){

      node.data = data;
      node.index = index;

      let name = node.querySelector( '.package-chooser-name' );

      if( data.installed ){
        name.parentNode.classList.add( "disabled" );
      }
      else name.parentNode.classList.remove( "disabled" );

      if( data.installed || data.selected ){
        name.parentNode.classList.add("chooser-checkbox-checked");
      }
      else {
        name.parentNode.classList.remove("chooser-checkbox-checked");
      }

      name.innerText = data[0];

    };

    // base template (FIXME: move to html file) 
    let nodetemplate = `
      <div class='package-chooser-entry'>
        <div class='chooser-checkbox'>
            <label class='package-chooser-name'></label>
        </div>
      </div>
    `;

    chooser.show(click, {fixSize: true}).then( function( result ){
       console.info( "Close dialog", result );
      chooser.nodes['package-chooser-filter'].removeEventListener( "input", updateFilter );
      vlist.cleanup();

      if( result === "OK" ){
        let list = [];
        for( let i = 0; i< data.length; i++ ){
          if( data[i].selected ){
            list.push( `"${data[i][0]}"` );
          }
        }
        if( list.length ){
          let cmd = `install.packages(c(${list.join(",")}))`;
          PubSub.publish( "execute-block", cmd );
        }
      }

    }).catch( function( err ){
      console.error(err);
    });

    // get list of installed packages.  don't cache this.
    R.internal(["exec", "installed.packages()"]).then( function( rslt ){

      let installed = [];
      if( rslt.type === "response" ){
        let rows = rslt.response.$data.value.$nrows;
        installed = rslt.response.$data.value.$data.slice(0, rows);
      }

      // next get list of available packages (unless we have cache)
      let p = data ? Promise.resolve(data) : R.internal([ "exec", "available.packages()" ], "package-chooser");
      p.then( function( obj ){

        if( obj.type === "response" ){

          // this is a matrix, column-major.
          let mat = obj.response.$data.value;
          data = new Array(mat.$nrows);

          for( let i = 0; i< mat.$nrows; i++ ){
            data[i] = new Array( mat.$ncols );
          }

          let index = 0;
          for( let j = 0; j< mat.$ncols; j++ ){
            for( let i = 0; i< mat.$nrows; i++, index++ ){
              data[i][j] = mat.$data[index];
            }
          }

          Cache.set( cacheKey, data, CRAN_CACHE_TIME );

        }
        else if( obj.type === "error" ){
          console.error(obj);

          // ...
        }

        // map installed flag... Q: are these in lexical sort order?
        // A: they're definitely not, so we have to do this the hard way.
        // A2: or sort, then do it?  is that actually cheaper? [probably]

        let scmp = function(a, b){ return a < b ? -1 : ( a > b ? 1 : 0 ); };
        let names = new Array( data.length );
        for( let i = 0; i< names.length; i++ ){
          names[i] = [ data[i][0], i ];
          data[i].index = i;
        };

        names.sort(function(a, b){ return scmp(a[0], b[0]); });
        installed.sort(scmp);

        for( let i = 0, j = 0; i< names.length && j< installed.length; ){
          let c = scmp( names[i][0], installed[j] );
          if( c === 0 ){
            data[names[i][1]].installed = true;
            data[names[i][1]][0] += ` (${Messages.INSTALLED})`; // FIXME: messages
            i++, j++;
          }
          else if( c < 0 ) i++;
          else j++;
        };

        chooser.nodes['package-chooser-wait'].style.display = "none";
        chooser.nodes['package-chooser-list'].style.display = "block";
      
        updateFilter(); // will implicitly create the list

      });
    });
  }).catch( function( err ){
    console.error(err);
  });
};

/**
 * show the package chooser, but ensure we have a good cran repo
 * first.  if the repo looks ok, go right to the package chooser.
 * otherwise open the mirror chooser.  if the mirror chooser resolves
 * to a URL, then continue; otherwise we're done.
 * 
 * FIXME: add a message to the console on cancel?
 */
module.exports.showPackageChooser = function(R, settings){

  R.internal([ "exec", "getOption('repos')['CRAN']" ]).then( function( repo ){
    if( repo.type === "response" && repo.response.$data.value.CRAN ){
      let cran = repo.response.$data.value.CRAN;
      if( !cran.match( /^http/i )){

        // see note where this is set
        cran = settings.cran.mirror;
        if( cran ){
          let cmd = `local({r <- getOption("repos"); r["CRAN"] <- "${cran}"; options(repos=r)})`;
          R.internal(['exec', cmd ]).then( function(){
            return Promise.resolve(cran);
          }).catch( function(e){
            return Promise.reject(e);
          });
        }
      }
      if(cran && cran.match( /^http/i )) return Promise.resolve( cran );
    } 
    return module.exports.showMirrorChooser();
  }).then( function(cran){
    if( cran && cran.match( /^http/ )){
      showPackageChooserInternal(R, settings, cran);
    }
  });

};

module.exports.showMirrorChooser = function(R, settings){

  // this function returns a promise so we can chain 
  // calls with the package chooser (assuming you click OK).
  // if you don't need it you can just discard.

  return new Promise( function( resolve, reject ){

    getTemplate( path.join( __dirname, "..", "data/mirror-chooser.template.html" )).then( function(template){

      let vlist, cran = undefined;
      let df = Cache.get( "mirror-list" );

      let chooser = new HTMLDialog(template, Messages);
      chooser.nodes['mirror-chooser-wait'].style.display = "block";
      chooser.nodes['mirror-chooser-list'].style.display = "none";

      let click = function(e){
        let n = e.target;
        while( n && n.parentNode && n.className !== "vlist-list-entry" ){
          n = n.parentNode;
        }
        if( n.className !== "vlist-list-entry" ) return null;
        let d = n.data;
        if( !d.selected ){
          for( let i = 0; i< df.length; i++ ){
            df[i].selected = ( df[i] === d );
            if( df[i].selected ) cran = df[i].URL;
          }
          vlist.repaint();
        }
      };

      // FIXME: don't allow OK without a selection

      chooser.show( click, { fixSize: true }).then( function( result ){
        vlist.cleanup();
        if( result === "OK" ){

          // for whatever reason, setting this as a string was breaking 
          // settings (without an obvious error).  we need to figure out what
          // that was, but for now encoding is a workaround.

          // Settings.cran.mirror = btoa(cran);
          if( !settings.cran ) settings.cran = {};
          settings.cran.mirror = cran;

          let cmd = `local({r <- getOption("repos"); r["CRAN"] <- "${cran}"; options(repos=r)})`;
          R.internal(['exec', cmd ]).then( function(){
            resolve(cran);
          }).catch( function(e){
            reject(e);
          });
        }
        else resolve(false);
      });

      R.internal([ "exec", "getOption('repos')['CRAN']" ]).then( function( repo ){
        if( repo.type === "response" && repo.response.$data.value.CRAN ){
          cran = repo.response.$data.value.CRAN;
          if( cran === "@CRAN@" && settings.cran && settings.cran.mirror ) cran = settings.cran.mirror;
        }
        return df ? Promise.resolve(df) : R.internal([ "exec", "getCRANmirrors()" ], "mirror-chooser");
      }).then(function (obj) {

        if( obj.type === "response" ){
          df = Utils.restructureDataFrame( obj.response.$data.value, true );
          Cache.set( "mirror-list", df, CRAN_CACHE_TIME );
        }
        else if( obj.type === "error" ){
          console.error( obj );

          // ...
        }

        // for whatever reason when storing the URL R adds a trailing 
        // slash -- are we sure that's universal?

        let firstIndex = 0;
        if( cran ){
          let cranslash = cran + "/";
          for( let i = 0; i< df.length; i++ ){
            df[i].selected = ( df[i].URL === cran ) || ( df[i].URL === cranslash );
            if( df[i].selected ) firstIndex = i;
          }
        }

        chooser.nodes['mirror-chooser-wait'].style.display = "none";
        chooser.nodes['mirror-chooser-list'].style.display = "block";

        let update = function( node, data, index ){
          node.querySelector( '.mirror-chooser-name' ).innerText = data.Name;
          node.querySelector( '.mirror-chooser-host' ).innerText = data.Host;

          let s = node.querySelector( '.chooser-radio' );
          if( data.selected ) s.classList.add( "chooser-radio-checked" );
          else s.classList.remove( "chooser-radio-checked" );

          node.data = data;
        };

        let nodetemplate = `
          <div class='mirror-chooser-entry'>
            <div class='chooser-radio'>
              <div class='chooser-label'>
                <div class='mirror-chooser-name'></div> 
                <div class='mirror-chooser-host'></div> 
              </div>
            </div>
          </div>
        `;

        vlist = new VList( chooser.nodes['mirror-chooser-list'], df, nodetemplate, update, { firstIndex: firstIndex });
      });
    });
  });

};
