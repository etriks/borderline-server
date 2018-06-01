//External node module imports
const mongodb = require('mongodb').MongoClient;
const fs = require('fs-extra');
const express = require('express');
const expressSession = require('express-session');
const MongoStore = require('connect-mongo')(expressSession);
const body_parser = require('body-parser');
const passport = require('passport');
const multer = require('multer');

const borderlineOptions = require('./core/options');
const { ErrorHelper, Constants, RegistryHelper } = require('borderline-utils');
const package_json = require('../package.json');

function BorderlineServer(config) {
    this.config = new borderlineOptions(config);
    this.app = express();

    // Bind private member functions
    this._connectDb = BorderlineServer.prototype._connectDb.bind(this);
    this._registryHandler = BorderlineServer.prototype._registryHandler.bind(this);

    // Bind member functions
    this.start = BorderlineServer.prototype.start.bind(this);
    this.stop = BorderlineServer.prototype.stop.bind(this);
    this.extensionError = BorderlineServer.prototype.extensionError.bind(this);
    this.setupRegistry = BorderlineServer.prototype.setupRegistry.bind(this);
    this.setupUserAccount = BorderlineServer.prototype.setupUserAccount.bind(this);
    this.setupDataStore = BorderlineServer.prototype.setupDataStore.bind(this);
    this.setupExtensionStore = BorderlineServer.prototype.setupExtensionStore.bind(this);
    this.setupUserExtensions = BorderlineServer.prototype.setupUserExtensions.bind(this);
    this.setupWorkflows = BorderlineServer.prototype.setupWorkflows.bind(this);
    this.setupMiddlware = BorderlineServer.prototype.setupMiddlware.bind(this);

    // Define config in global scope (needed for server extensions)
    global.config = this.config;

    // Configure EXPRESS.JS router
    // Remove unwanted express headers
    this.app.set('x-powered-by', false);
    // Allow CORS requests when enabled
    if (this.config.enableCors === true) {
        this.app.use(function (__unused__req, res, next) {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });
    }
    // Middleware imports
    this.userPermissionsMiddleware = require('./middlewares/userPermissions');
    // Init third party middleware for parsing HTTP requests body
    this.app.use(body_parser.urlencoded({ extended: true }));
    this.app.use(body_parser.json());
}

/**
 * @fn start
 * @desc Start the BorderlineServer service, routes are setup and
 * automatic status update is triggered.
 * @return {Promise} Resolve to a native Express.js router ready to use on success.
 * In case of error, an ErrorStack is rejected.
 */
BorderlineServer.prototype.start = function () {
    let _this = this;
    return new Promise(function (resolve, reject) {
        _this._connectDb().then(function () {
            // Setup sessions with third party middleware
            _this.app.use(expressSession({
                secret: 'borderline',
                saveUninitialized: false,
                resave: false,
                cookie: { secure: false },
                store: _this.mongoStore
            })
            );
            _this.app.use(passport.initialize());
            _this.app.use(passport.session());

            // Setup Registry update
            _this._registryHandler();

            //Setup route using controllers
            _this.setupRegistry();
            _this.setupUserAccount();
            _this.setupDataStore();
            _this.setupExtensionStore();
            _this.setupUserExtensions();
            _this.setupWorkflows();
            _this.setupMiddlware();

            _this.app.all('/*', function (__unused__req, res) {
                res.status(400);
                res.json(ErrorHelper('Bad request'));
            });

            // All good, return the express app router
            resolve(_this.app);
        }, function (error) {
            reject(ErrorHelper('Could not connect to the database', error));
        });
    });
};

/**
 * @fn stop
 * @desc Stops the borderline server service. After a call to stop, all references on the
 * express router MUST be released and this service endpoints are expected to fail.
 * @return {Promise} Resolve to true on success, ErrorStack otherwise
 */
BorderlineServer.prototype.stop = function () {
    let _this = this;
    return new Promise(function (resolve, reject) {
        // Stop periodic update of the registry
        _this.registryHelper.stopPeriodicUpdate();

        // Disconnect mongoDB --force
        _this.db.close(true).then(function (main_error) {
            if (main_error)
                reject(ErrorHelper('Closing main mongoDB connection failed', main_error));
            else {
                resolve(true); // Everything is stopped
            }
        });
    });
};

/**
 * @fn _registryHandler
 * @desc Setup the RegistryHelper and starts interval update
 * @private
 */
BorderlineServer.prototype._registryHandler = function () {
    let _this = this;

    // Connect to the registry collection
    _this.registryCollection = _this.db.collection(Constants.BL_GLOBAL_COLLECTION_REGISTRY);
    // Create RegistryHelper class
    _this.registryHelper = new RegistryHelper(Constants.BL_SERVER_SERVICE, _this.registryCollection);
    // Sets properties in the registry
    _this.registryHelper.setModel({
        status: Constants.BL_SERVICE_STATUS_IDLE,
        version: package_json.version,
        port: _this.config.port
    });

    // Trigger updates
    _this.registryHelper.startPeriodicUpdate(Constants.BL_DEFAULT_REGISTRY_FREQUENCY);
};


/**
 * @fn _connectDb
 * @desc Setup the connections with mongoDB
 * @return {Promise} Resolves to true on success
 * @private
 */
BorderlineServer.prototype._connectDb = function () {
    let _this = this;
    let main_db = new Promise(function (resolve, reject) {
        mongodb.connect(_this.config.mongoURL, function (err, db) {
            if (err !== null && err !== undefined) {
                reject(ErrorHelper('Failed to connect to mongoDB', err));
                return;
            }
            _this.db = db;
            _this.mongoStore = new MongoStore({ db: db, ttl: Constants.BL_DEFAULT_SESSION_TIMEOUT, collection: Constants.BL_GLOBAL_COLLECTION_SESSIONS });
            resolve(true);
        });
    });

    return new Promise(function (resolve, reject) {
        Promise.all([main_db]).then(function (__unused__true_array) {
            resolve(true);
        }, function (error) {
            reject(ErrorHelper('One of the db connection failed', error));
        });
    });
};

/**
 * @fn setupRegistry
 * @desc Initialize the registry related routes
 */
BorderlineServer.prototype.setupRegistry = function () {
    // Import the controller
    let registryController = require('./controllers/registryController');
    this.registryController = new registryController(this.registryHelper);

    this.app.get('/status', this.registryController.getServiceStatus);
    this.app.get('/details', this.registryController.getServiceDetails);
};

/**
 * @fn setupUserAccount
 * @desc Initialize users account management routes and controller
 */
BorderlineServer.prototype.setupUserAccount = function () {
    //Controller imports
    let userAccountController = require('./controllers/userAccountController');
    this.userAccountController = new userAccountController(this.db.collection(Constants.BL_SERVER_COLLECTION_USERS));

    //Passport session serialize and deserialize
    passport.serializeUser(this.userAccountController.serializeUser);
    passport.deserializeUser(this.userAccountController.deserializeUser);

    //[ Login and sessions Routes
    this.app.route('/login')
        .post(this.userAccountController.login); //POST login information
    this.app.route('/logout')
        .post(this.userAccountController.logout); //POST logout from session
    this.app.route('/whoami')
        .get(this.userAccountController.whoAmI); //GET current session user
    this.app.route('/2step/:user_id/')
        .put(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userAccountController.put2step); //PUT regenerate secret
    this.app.route('/2step/login')
        .post(this.userAccountController.login2); //POST login with 2 step ON
    this.app.route('/users')
        .get(this.userPermissionsMiddleware.adminPrivileges, this.userAccountController.getUsers);//GET returns the list of users
    this.app.route('/users/:user_id')
        .get(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userAccountController.getUserById) //GET user details by ID
        .post(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userAccountController.postUserById) //POST Update user details
        .delete(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userAccountController.deleteUserById); //DELETE Removes a user
    // ] Login and sessions routes
};

/**
 * @fn setupDataStore
 * @desc Initialize data sources management routes and controller
 */
BorderlineServer.prototype.setupDataStore = function () {
    // Data sources controller import
    let dataStoreControllerModule = require('./controllers/dataStoreController');
    this.dataStoreController = new dataStoreControllerModule(this.db.collection(Constants.BL_SERVER_COLLECTION_DATA_SOURCES));

    //[ Data sources routes
    this.app.route('/data_sources/')
        .get(this.dataStoreController.getDataStore) // GET all data sources
        .post(this.dataStoreController.postDataStore); // POST New data source
    this.app.route('/data_sources/:source_id')
        .get(this.dataStoreController.getDataStoreByID) // GET a single data source
        .put(this.dataStoreController.putDataStoreByID) // PUT Update a single data source
        .delete(this.dataStoreController.deleteDataStoreByID); //DELETE a single data source
    this.app.route('/users/:user_id/data_sources')
        .get(this.userPermissionsMiddleware.userOrAdminPrivileges, this.dataStoreController.getUserDataSources); // GET all user's data sources
    this.app.route('/users/:user_id/data_sources/:source_id')
        .post(this.userPermissionsMiddleware.userOrAdminPrivileges, this.dataStoreController.postUserDataSourceByID) //POST Subscribe a user to a data source
        .delete(this.userPermissionsMiddleware.userOrAdminPrivileges, this.dataStoreController.deleteUserDataSourceByID); // DELETE Unsubscribe user to data source
    // ] Data sources routes
};

/**
 * @fn setupExtensionStore
 * @desc Initialize global extensions management routes and controller
 */
BorderlineServer.prototype.setupExtensionStore = function () {
    if (this.config.hasOwnProperty('extensionSourcesFolder') === false) {
        this.extensionError('No extensionSourcesFolder in options');
        return;
    }
    if (fs.existsSync(this.config.extensionSourcesFolder) === false) {
        this.extensionError('Directory ' + this.config.extensionSourcesFolder + ' not found');
        return;
    }

    let extensionStoreController = require('./controllers/extensionStoreController');
    this.extensionStoreController = new extensionStoreController(this.db.collection(Constants.BL_SERVER_COLLECTION_EXTENSIONS));

    // [ Extension Store Routes

    this.app.use('/extensions', this.extensionStoreController.getExtensionStoreRouter()); //Extensions routers connect here
    this.app.route('/extension_store')
        .get(this.extensionStoreController.getAllExtensions) //GET returns the list of available extensions
        .post(multer().any(), this.extensionStoreController.postExtensionStore); //POST upload a new extension
    this.app.route('/extension_store/:id')
        .get(this.extensionStoreController.getExtensionByID) //:id GET returns extension metadata
        .post(multer().any(), this.extensionStoreController.postExtensionByID) //:id POST update a extension content
        .delete(this.extensionStoreController.deleteExtensionByID); //:id DELETE removes a specific extension
    // ] Extension Store Routes
};

/**
 * @fn setupUserExtensions
 * @desc Initialize users extensions management routes and controller
 */
BorderlineServer.prototype.setupUserExtensions = function () {
    let userExtensionControllerModule = require('./controllers/userExtensionController');
    this.userExtensionController = new userExtensionControllerModule(
        this.db.collection(Constants.BL_SERVER_COLLECTION_USERS),
        this.db.collection(Constants.BL_SERVER_COLLECTION_EXTENSIONS));

    //[ Extensions subscriptions
    this.app.route('/users/:user_id/extensions')
        .get(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userExtensionController.getExtensions) //GET List user extensions
        .delete(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userExtensionController.deleteExtensions); //DELETE Forget all extensions for user
    this.app.route('/users/:user_id/extensions/:extension_id')
        .put(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userExtensionController.subscribeExtension) //PUT Subscribe a user to extension
        .delete(this.userPermissionsMiddleware.userOrAdminPrivileges, this.userExtensionController.unsubscribeExtension); //DELETE Un-subscribe from a extension
    //] Extensions subs
};

/**
 * @fn setupWorkflows
 * @desc Initialize workflow management routes and controller
 */
BorderlineServer.prototype.setupWorkflows = function () {
    let workflowControllerModule = require('./controllers/workflowController');
    this.workflowController = new workflowControllerModule(
        this.db.collection(Constants.BL_SERVER_COLLECTION_WORKFLOW),
        this.db.collection(Constants.BL_SERVER_COLLECTION_STEPS));

    //[ Workflow endpoints
    this.app.route('/workflow')
        .get(this.workflowController.getWorkflow) //GET List all workflow
        .put(this.workflowController.putWorkflow); //PUT Create a new workflow
    this.app.route('/workflow/:workflow_id')
        .get(this.workflowController.getWorkflowByID) //GET A workflow from ID
        .post(this.workflowController.postWorkflowByID) //POST a workflow from ID
        .delete(this.workflowController.deleteWorkflowByID); //DELETE a workflow from ID
    this.app.route('/workflow/:workflow_id/step')
        .get(this.workflowController.getStep) //GET A workflow steps from workflow ID
        .put(this.workflowController.putStep);//PUT A new workflow step from workflow ID
    this.app.route('/workflow/:workflow_id/step/:step_id')
        .get(this.workflowController.getStepByID) //GET A step by ID from a workflow by ID
        .post(this.workflowController.postStepByID) //POST A step by ID in a Workflow by ID
        .delete(this.workflowController.deleteStepByID); //DELETE a step by ID in a workflow by ID
    // ] Workflow endpoints
};

/**
 * @fn setupMiddlware
 * @desc Initialize workflow management routes and controller
 */
BorderlineServer.prototype.setupMiddlware = function () {
    let middlewareControllerModule = require('./controllers/middlewareController');
    this.middlewareController = new middlewareControllerModule(this.registryCollection);

    //[ Middleware endpoints
    this.app.use('/query', this.middlewareController.getMiddlewareRouter()); //Extensions routers connect here
    // ] Middleware endpoints
};

/**
 * @fn extensionsError
 * @desc Disables extension routes to send error message instead
 * @param message A message string to use in responses
 */
BorderlineServer.prototype.extensionError = function (message) {
    this.app.all('/extension_store', function (__unused__req, res) {
        res.status(204);
        res.json(ErrorHelper('Extension store is disabled', message));
    });
    this.app.all('/extensions/*', function (__unused__req, res) {
        res.status(204);
        res.json(ErrorHelper('Extensions are disabled', message));
    });
};

module.exports = BorderlineServer;
