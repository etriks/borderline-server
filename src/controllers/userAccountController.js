const speakeasy = require('speakeasy');
let userAccounts = require('../core/userAccounts');
const { ErrorHelper } = require('borderline-utils');

/**
 * @fn UserAccountController
 * @desc Contrller to manage the users accounts, sessions & credentials
 * @param mongoDBCollection MongoDB collection where the users are stored
 * @constructor
 */
function UserAccountController(mongoDBCollection) {
    this.userCollection = mongoDBCollection;
    this.users = new userAccounts(mongoDBCollection);

    this.serializeUser = UserAccountController.prototype.serializeUser.bind(this);
    this.deserializeUser = UserAccountController.prototype.deserializeUser.bind(this);
    this.getUsers = UserAccountController.prototype.getUsers.bind(this);
    this.login = UserAccountController.prototype.login.bind(this);
    this.logout = UserAccountController.prototype.logout.bind(this);
    this.whoAmI = UserAccountController.prototype.whoAmI.bind(this);
    this.login2 = UserAccountController.prototype.login2.bind(this);
    this.put2step = UserAccountController.prototype.put2step.bind(this);
    this.getUserById = UserAccountController.prototype.getUserById.bind(this);
    this.postUserById = UserAccountController.prototype.postUserById.bind(this);
    this.deleteUserById = UserAccountController.prototype.deleteUserById.bind(this);
}

/**
 * @fn serializeUser
 * @desc Called by session middleware to simplify user model
 * @param deserializedUser User as a plain JS object with all its properties
 * @param done
 */
UserAccountController.prototype.serializeUser = function(deserializedUser, done) {
    if (deserializedUser.hasOwnProperty('_id') === false)
        done('User has no ID', null);
    else {
        done(null,
            {
                id: deserializedUser._id,
                admin: deserializedUser.admin
            });
    }
};

/**
 * @fn deserializeUser
 * @desc Called by session middleware to roll back on the user model
 * @param serializedUser As returned by deserializeUser
 * @param done Callback to pass the deserialized user result to
 */
UserAccountController.prototype.deserializeUser = function(serializedUser, done) {
    this.users.findById(serializedUser.id).then(function (user) {
        done(null, user);
    }, function(error) {
        done('Session broke: ' + error, null);
    });
};

/**
 * @fn getUsers
 * @desc Get all users form the server
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.getUsers = function(__unused__req, res) {
   this.users.findAll().then(function(users) {
       res.status(200);
       res.json(users);
   },
   function(error) {
      res.status(401);
      res.json(ErrorHelper('Cannot list users', error));
   });
};

/**
 * @fn login
 * @desc Handles user login, basic
 * Creates a new session on success
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.login = function(req, res) {
    let that = this;
    let rejected = function(reason) {
        res.status(400);
        res.send(ErrorHelper('Failed to login', reason));
    };

    let username = req.body.username;
    let password = req.body.password;
    if (!username || !password) {
        rejected('Missing username or password');
        return;
    }

    this.users.findByUsernameAndPassword(username, password)
        .then(
            function (user) {
                return new Promise(function (resolve, __unused__reject) {
                    //Known user match
                    resolve(user);
                });
            },
            function(__unused__error) {
                return new Promise(function(resolve, reject) {
                //Try to find user in external DB and create in local
                that.users.registerExternalByUsernameAndPassword(username, password).then(function (user) {
                        resolve(user);
                    }, reject);
                });
            }
        )
        .then(function(user) {
            req.login(user, function (err) {
                if (err) {
                    rejected(err);
                    return;
                }
                res.status(200);
                res.json(user);
            });
        }, rejected);
};

/**
 * @fn login2
 * @desc Handles user login, with OAuth2 support.
 * Creates a new session on success
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.login2 = function(req, res) {
    let rejected = function(reason) {
        res.status(400);
        res.send(ErrorHelper('Failed to login', reason));
    };

    let username = req.body.username;
    let password = req.body.password;
    let token = req.body.token;
    if (!username || !password || !token) {
        rejected('Missing username or password or token');
        return;
    }

    this.users.findByUsernameAndPassword(username, password)
        .then(
            function (user) {
                let verified = speakeasy.totp.verify({
                        secret: user.secret.base32,
                        encoding: 'base32',
                        token: token
                    }
                );
                if (verified) {
                    req.login(user, function(err) {
                        if (err) {
                            rejected(err.toString());
                        }
                        else {
                            res.status(200);
                            res.json(user);
                        }
                    });
                } else {
                    rejected('2 step identification failed');
                }
            },
            function(error) {
                rejected(ErrorHelper(error));
            }
        );
};

/**
 * @fn put2step
 * @desc Given a user ID, re create a new OAuth2 token
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.put2step = function(req, res) {
    let user_id = req.params.user_id;

    if (user_id === undefined || user_id === null) {
        res.status(400);
        res.json(ErrorHelper('Unknown user id'));
        return;
    }

    this.users.regenerateSecret(user_id).then(function (user) {
            if (user === undefined || user === null) {
                res.status(404);
                res.json(ErrorHelper('Unknown user id'));
                return;
            }
            res.status(200);
            res.send(user.secret.otpauth_url);
        },
        function(error) {
            res.status(400);
            res.json(ErrorHelper(error));
        }
    );
};

/**
 * @fn logout
 * @desc Terminates the current session if any
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.logout = function(req, res) {
    req.session.destroy(function(err) {
        if (req.user === undefined || req.user === null) {
            res.status(401);
            res.json(ErrorHelper('Not logged in'));
            return;
        }
        req.logout();
        if (err) {
            res.status(500);
            res.json(ErrorHelper('Cannot destroy session', err));
        }
        else {
            res.status(200);
            res.json({ message: 'Successful logout' });
        }
    });
};

/**
 * @fn whoAmI
 * @desc Based on the current session,
 * returns which user if logged in if any
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.whoAmI = function(req, res) {
    let Iam = req.user;
    if (Iam === undefined || Iam === null) {
        res.status(404);
        res.json(ErrorHelper('An unknown unicorn'));
    }
    else {
        res.status(200);
        res.json(Iam);
    }
};


/**
 * @fn getUserByID
 * @desc Get a user referenced by its unique identifier
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.getUserById = function(req, res) {
    let user_id = req.params.user_id;

    this.users.findById(user_id).then(function(user) {
        res.status(200);
        res.json(user);
    },
    function(error) {
        res.status(404);
        res.json(ErrorHelper('Can find user by ID', error));
    });
};

/**
 * @fn postUserByID
 * @desc Updates a user referenced by ID
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.postUserById = function(req, res) {
    let user_id = req.params.user_id;

    this.users.updateById(user_id, req.body).then(function (user)
        {
            res.status(200);
            res.json(user);
        },
        function(error) {
            res.status(400);
            res.json(ErrorHelper('Failed to update user', error));
        });
};

/**
 * @fn deleteUSerByID
 * @desc Removes a user, referenced by its ID
 * @param req Express.js request object
 * @param res Express.js response object
 */
UserAccountController.prototype.deleteUserById = function(req, res) {
    let user_id = req.params.user_id;

    this.users.deleteById(user_id).then(function (user)
        {
            req.logout();
            res.status(200);
            res.json({ deleted: user });
        },
        function(error) {
            res.status(400);
            res.json(ErrorHelper('Failed to delete user', error));
        });
};

module.exports = UserAccountController;
