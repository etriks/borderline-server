//External node module imports
var mongodb = require('mongodb').MongoClient;
var path = require('path');
var fs = require('fs-extra');
var express = require('express');
var expressSession = require('express-session');
var body_parser = require('body-parser');
const passport = require('passport');
const passportLocal = require('passport-local').Strategy;
var multer  = require('multer');

function BorderlineServer(options) {
    this.options = options;
    this.app = express();

    this.mongoError = BorderlineServer.prototype.mongoError.bind(this);
    this.pluginError = BorderlineServer.prototype.pluginError.bind(this);

    this.setupUserAccount = BorderlineServer.prototype.setupUserAccount.bind(this);
    this.setupUserDataSources = BorderlineServer.prototype.setupUserDataSources.bind(this);
    this.setupPluginStore = BorderlineServer.prototype.setupPluginStore.bind(this);

    //Configuration import
    global.config = options;

    if (options.hasOwnProperty('mongoUrl') == false) {
        this.mongoError('No mongoUrl provided');
        return this.app;
    }

    var that = this;
    mongodb.connect(global.config.mongoUrl, function(err, db) {
        if (err !== null) {
            that.mongoError(err.toString());
            return that.app;
        }
        that.db = db;

        //Middleware imports
        that.userPermissionsMiddleware = require('./middlewares/userPermissions');

        //Init external middleware
        that.app.use(body_parser.urlencoded({ extended: true }));
        that.app.use(body_parser.json());
        that.app.use(expressSession({ secret: 'borderline', saveUninitialized: false, resave: false }));
        that.app.use(passport.initialize());
        that.app.use(passport.session());

        //Setup route using controllers
        that.setupUserAccount();
        that.setupUserDataSources();
        that.setupPluginStore();

    });

    return this.app;
}


BorderlineServer.prototype.setupUserAccount = function() {
    //Controller imports
    var userAccountController = require('./controllers/userAccountController');
    this.userAccountController = new userAccountController(this.db.collection('users'));

    //Passport session serialize and desierialize
    passport.serializeUser(this.userAccountController.serializeUser);
    passport.deserializeUser(this.userAccountController.deserializeUser);

    //[ Login and sessions Routes
    //TEMPORARY getter on login form
    this.app.get('/login/form', this.userAccountController.getLoginForm); //GET login form

    this.app.route('/login')
        .post(this.userAccountController.login); //POST login information
    this.app.route('/logout')
        .post(this.userAccountController.logout); //POST logout from session
    this.app.route('/users')
        .get(this.userPermissionsMiddleware.adminPrivileges, this.userAccountController.getUsers);//GET returns the list of users
    this.app.route('/users/:user_id')
        .get(this.userAccountController.getUserById) //GET user details by ID
        .post(this.userAccountController.postUserById) //POST Update user details
        .delete(this.userAccountController.deleteUserById); //DELETE Removes a user
    // ] Login and sessions routes
};

BorderlineServer.prototype.setupUserDataSources = function(){
    var userDataSourcesController = require('./controllers/userDataSourcesController');
    this.userDataSourcesController = new userDataSourcesController(this.db.collection('users'));

    //[ Data sources routes
    this.app.route('/users/:user_id/data_source')
        .get(this.userDataSourcesController.getDataSources)
        .post(this.userDataSourcesController.postDataSources)
        .delete(this.userDataSourcesController.deleteDataSources)
        .put(this.userDataSourcesController.putDataSources);
    this.app.route('/users/:user_id/data_source/:data_source_id')
        .get(this.userDataSourcesController.getUserDataSource)
        .delete(this.userDataSourcesController.deleteUserDataSource)
        .post(this.userDataSourcesController.postUserDataSource);
    // ] Data sources routes
};

BorderlineServer.prototype.setupPluginStore = function() {
    if (this.options.hasOwnProperty('pluginFolder') == false) {
        this.pluginError('No pluginFolder in options');
        return;
    }
    if (fs.existsSync(this.options.pluginFolder) == false) {
        this.pluginError('Directory ' + this.options.pluginFolder + ' not found');
        return;
    }

    var pluginStoreController = require('./controllers/pluginStoreController');
    this.pluginStoreController = new pluginStoreController();

    // [ Plugin Store Routes
    //TEMPORARY getter on a form to upload plugins zip file
    this.app.get('/plugin_store/upload', this.pluginStoreController.getPluginStoreUpload);
    //TEMPORARY getter on a form to update plugins zip file
    this.app.get('/plugin_store/upload/:id', this.pluginStoreController.getPluginStoreUploadByID);

    this.app.use('/plugins', this.pluginStoreController.getPluginStoreRouter()); //Plugins routers connect here
    this.app.route('/plugin_store')
        .get(this.pluginStoreController.getPluginStore) //GET returns the list of available plugins
        .post(multer().any(), this.pluginStoreController.postPluginStore) //POST upload a new plugin
        .delete(this.pluginStoreController.deletePluginStore); //DELETE clears all the plugins
    this.app.route('/plugin_store/:id')
        .get(this.pluginStoreController.getPluginByID) //:id GET returns plugin metadata
        .post(multer().any(), this.pluginStoreController.postPluginByID) //:id POST update a plugin content
        .delete(this.pluginStoreController.deletePluginByID); //:id DELETE removes a specific plugin
    // ] Plugin Store Routes
};

BorderlineServer.prototype.mongoError = function(message) {
    this.app.all('*', function(req, res) {
        res.status(401);
        res.json({ error: 'Could not connect to the database: [' + message + ']' });
    });
};

BorderlineServer.prototype.pluginError = function(message) {
    this.app.all('/plugin_store', function(req, res) {
        res.status(401);
        res.json({ error: 'Plugin store is disabled: [' + message + ']' });
    });
    this.app.all('/plugins/*', function(req, res) {
        res.status(401);
        res.json({ error: 'Plugins are disabled: [' + message + ']'});
    });
};

module.exports = BorderlineServer;
