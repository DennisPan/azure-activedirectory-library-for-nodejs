/*
 * @copyright
 * Copyright © Microsoft Open Technologies, Inc.
 *
 * All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http: *www.apache.org/licenses/LICENSE-2.0
 *
 * THIS CODE IS PROVIDED *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS
 * OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION
 * ANY IMPLIED WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A
 * PARTICULAR PURPOSE, MERCHANTABILITY OR NON-INFRINGEMENT.
 *
 * See the Apache License, Version 2.0 for the specific language
 * governing permissions and limitations under the License.
 */
'use strict';

var constants = require('./constants');
var CacheDriver = require('./cache-driver');
var Logger = require('./log').Logger;
var Mex = require('./mex');
var OAuth2Client = require('./oauth2client');
var UserRealm = require('./user-realm');
var WSTrustRequest = require('./wstrust-request');

var OAuth2Parameters = constants.OAuth2.Parameters;
var TokenResponseFields = constants.TokenResponseFields;
var OAuth2GrantType = constants.OAuth2.GrantType;
var OAuth2Scope = constants.OAuth2.Scope;
var Saml = constants.Saml;
var AccountType = constants.UserRealm.AccountType;

/**
 * Constructs a new TokenRequest object.
 * @constructor
 * @private
 * @param {object} callContext Contains any context information that applies to the request.
 * @param {AuthenticationContext} authenticationContext
 * @param {string} resource
 * @param {string} clientId
 * @param {string} redirectUri
 */
function TokenRequest(callContext, authenticationContext, clientId, resource, redirectUri) {
  this._log = new Logger('TokenRequest', callContext._logContext);
  this._callContext = callContext;
  this._authenticationContext = authenticationContext;
  this._resource = resource;
  this._clientId = clientId;
  this._redirectUri = redirectUri;

  // This should be set at the beginning of getToken
  // functions that have a userId.
  this._userId = null;

  this._userRealm = null;
}

TokenRequest.prototype._createUserRealmRequest = function(username) {
  return new UserRealm(this._callContext, username, this._authenticationContext.authority);
};

TokenRequest.prototype._createMex = function(mexEndpoint) {
  return new Mex(this._callContext, mexEndpoint);
};

TokenRequest.prototype._createWSTrustRequest = function(wstrustEndpoint, appliesTo) {
  return new WSTrustRequest(this._callContext, wstrustEndpoint, appliesTo);
};

TokenRequest.prototype._createOAuth2Client = function() {
  return new OAuth2Client(this._callContext, this._authenticationContext._authority);
};

TokenRequest.prototype._oauthGetToken = function(oauthParameters, callback) {
  var client = this._createOAuth2Client();
  client.getToken(oauthParameters, callback);
};

TokenRequest.prototype._createCacheDriver = function() {
  return new CacheDriver(
    this._callContext,
    this._authenticationContext.authority,
    this._resource,
    this._clientId,
    this._authenticationContext.cache,
    this._getTokenWithTokenResponse.bind(this)
    );
};

/**
 * Used by the cache driver to refresh tokens.
 * @param  {TokenResponse}   entry    A token response to refresh.
 * @param  {string}   resource The resource for which to get the token.
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype._getTokenWithTokenResponse = function(entry, resource, callback) {
  this._log.verbose('Called to refresh a token from the cache.');
  var refreshToken = entry[TokenResponseFields.REFRESH_TOKEN];
  this._getTokenWithRefreshToken(refreshToken, resource, null, callback);
};

TokenRequest.prototype._createCacheQuery = function() {
  var query = {
    clientId : this._clientId
  };

  if (this._userId) {
    query.userId = this._userId;
  } else {
    this._log.verbose('No userId passed.');
  }

  return query;
};

TokenRequest.prototype._getToken = function(callback, getTokenFunc) {
  var self = this;
  this._cacheDriver = this._createCacheDriver();
  var cacheQuery = this._createCacheQuery();
  this._cacheDriver.find(cacheQuery, function(err, token) {
    if (err) {
      self._log.warn('Attempt to look for token in cache resulted in Error: ' + err.stack);
    }

    if (!token) {
      self._log.verbose('No appropriate cached token found.');
      getTokenFunc.call(self, function(err, tokenResponse) {
        if (err) {
          self._log.verbose('getTokenFunc returned with err');
          callback(err, tokenResponse);
          return;
        }

        self._log.verbose('Successfully retrieved token from authority');
        self._cacheDriver.add(tokenResponse, function() {
          callback(null, tokenResponse);
        });
      });
    } else {
      self._log.info('Returning cached token.');
      callback(err, token);
    }
  });
};

/**
 * Adds an OAuth parameter to the paramters object if the parameter is
 * not null or undefined.
 * @private
 * @param {object} parameters  OAuth parameters object.
 * @param {string} key         A member of the OAuth2Parameters constants.
 * @param {object} value
 */
function _addParameterIfAvailable(parameters, key, value) {
  if (value) {
    parameters[key] = value;
  }
}

/**
 * Creates a set of basic, common, OAuthParameters based on values that the TokenRequest
 * was created with.
 * @private
 * @param  {string} grantType  A member of the OAuth2GrantType constants.
 * @return {object}
 */
TokenRequest.prototype._createOAuthParameters = function(grantType) {
  var oauthParameters = {};
  oauthParameters[OAuth2Parameters.GRANT_TYPE] = grantType;

  if (OAuth2GrantType.AUTHORIZATION_CODE !== grantType &&
    OAuth2GrantType.CLIENT_CREDENTIALS !== grantType &&
    OAuth2GrantType.REFRESH_TOKEN !== grantType) {
    oauthParameters[OAuth2Parameters.SCOPE] = OAuth2Scope.OPENID;
  }

  _addParameterIfAvailable(oauthParameters, OAuth2Parameters.CLIENT_ID, this._clientId);
  _addParameterIfAvailable(oauthParameters, OAuth2Parameters.RESOURCE, this._resource);
  _addParameterIfAvailable(oauthParameters, OAuth2Parameters.REDIRECT_URI, this._redirectUri);

  return oauthParameters;
};

/**
 * Get's a token from AAD using a username and password
 * @private
 * @param  {string}   username
 * @param  {string}   password
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype._getTokenUsernamePasswordManaged = function(username, password, callback) {
  this._log.verbose('Acquiring token with username password for managed user');

  var oauthParameters = this._createOAuthParameters(OAuth2GrantType.PASSWORD);

  oauthParameters[OAuth2Parameters.PASSWORD] = password;
  oauthParameters[OAuth2Parameters.USERNAME] = username;

  this._oauthGetToken(oauthParameters, callback);
};

/**
 * Determines the OAuth SAML grant type to use based on the passed in TokenType
 * that was returned from a RSTR.
 * @param  {string} wstrustResponse RSTR token type.
 * @return {string}                 An OAuth grant type.
 */
TokenRequest.prototype._getSamlGrantType = function(wstrustResponse) {
  var tokenType = wstrustResponse.tokenType;
  switch (tokenType) {
    case Saml.TokenTypeV1:
      return OAuth2GrantType.SAML1;
    case Saml.TokenTypeV2:
      return OAuth2GrantType.SAML2;
    default:
      throw this._log.createError('RSTR returned unknown token type: ' + tokenType);
  }
};

/**
 * Performs an OAuth SAML Assertion grant type exchange.  Uses a SAML token as the credential for getting
 * an OAuth access token.
 * @param  {WSTrustResponse}   wstrustResponse A response from a WSTrustRequest
 * @param  {AcquireTokenCallback} callback        callback
 */
TokenRequest.prototype._performWSTrustAssertionOAuthExchange = function(wstrustResponse, callback) {
  this._log.verbose('Performing OAuth assertion grant type exchange.');

  var oauthParameters;
  try {
    var grantType = this._getSamlGrantType(wstrustResponse);
    var assertion = new Buffer(wstrustResponse.token).toString('base64');
    oauthParameters = this._createOAuthParameters(grantType);
    oauthParameters[OAuth2Parameters.ASSERTION] = assertion;
  } catch (err) {
    callback(err);
    return;
  }
  this._oauthGetToken(oauthParameters, callback);
};

/**
 * Exchange a username and password for a SAML token from an ADFS instance via WSTrust.
 * @param  {string}   wstrustEndpoint An url of an ADFS WSTrust endpoint.
 * @param  {string}   username        username
 * @param  {string}   password        password
 * @param  {AcquireTokenCallback} callback        callback
 */
TokenRequest.prototype._performWSTrustExchange = function(wstrustEndpoint, username, password, callback) {
  var self = this;
  var wstrust = this._createWSTrustRequest(wstrustEndpoint, 'urn:federation:MicrosoftOnline');
  wstrust.acquireToken(username, password, function(rstErr, response) {
    if (rstErr) {
      callback(rstErr);
      return;
    }

    if (!response.token) {
      var rstrErr = self._log.createError('Unsucessful RSTR.\n\terror code: ' + response.errorCode + '\n\tfaultMessage: ' + response.faultMessage);
      callback(rstrErr);
      return;
    }

    callback(null, response);
  });
};

/**
 * Given a username and password this method invokes a WSTrust and OAuth exchange to get an access token.
 * @param  {string}   wstrustEndpoint An url of an ADFS WSTrust endpoint.
 * @param  {string}   username        username
 * @param  {string}   password        password
 * @param  {AcquireTokenCallback} callback        callback
 */
TokenRequest.prototype._performUsernamePasswordForAccessTokenExchange = function(wstrustEndpoint, username, password, callback) {
  var self = this;
  this._performWSTrustExchange(wstrustEndpoint, username, password, function(err, wstrustResponse) {
    if (err) {
      callback(err);
      return;
    }

    self._performWSTrustAssertionOAuthExchange(wstrustResponse, callback);
  });
};

/**
 * Returns an Error object indicating that AAD did not return a WSTrust endpoint.
 * @return {Error}
 */
TokenRequest.prototype._createADWSTrustEndpointError = function() {
  return this._log.createError('AAD did not return a WSTrust endpoint.  Unable to proceed.');
};

/**
 * Gets an OAuth access token using a username and password via a federated ADFS instance.
 * @param  {string}   username        username
 * @param  {string}   password        password
 * @param  {AcquireTokenCallback} callback        callback
 */
TokenRequest.prototype._getTokenUsernamePasswordFederated = function(username, password, callback) {
  this._log.verbose('Acquiring token with username password for federated user');

  var self = this;
  if (!this._userRealm.federationMetadataUrl) {
    this._log.warn('Unable to retrieve federationMetadataUrl from AAD.  Attempting fallback to AAD supplied endpoint.');

    if (!this._userRealm.federationActiveAuthUrl) {
      callback(this._createADWSTrustEndpointError());
      return;
    }

    this._performUsernamePasswordForAccessTokenExchange(this._userRealm.federationActiveAuthUrl, username, password, callback);
    return;
  } else {
    var mexEndpoint = this._userRealm.federationMetadataUrl;
    this._log.verbose('Attempting mex at: ' + mexEndpoint);
    var mex = this._createMex(mexEndpoint);
    mex.discover(function(mexErr) {
      var wstrustEndpoint;
      if (mexErr) {
        self._log.warn('MEX exchnage failed.  Attempting fallback to AAD supplied endpoint.');

        wstrustEndpoint = self._userRealm.federationActiveAuthUrl;
        if (!wstrustEndpoint) {
          callback(self._createADWSTrustEndpointError());
          return;
        }
      } else {
        wstrustEndpoint = mex.usernamePasswordUrl;
      }

      self._performUsernamePasswordForAccessTokenExchange(wstrustEndpoint, username, password, callback);
      return;
    });
  }
};

/**
 * Decides whether the username represents a managed or a federated user and then
 * obtains a token using the approprate protocol flow.
 * @private
 * @param  {string}   username
 * @param  {string}   password
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype.getTokenWithUsernamePassword = function(username, password, callback) {
  this._log.info('Acquiring token with username password');

  this._userId = username;
  this._getToken(callback, function(innerCallback) {
    var self = this;
    this._userRealm = this._createUserRealmRequest(username);
    this._userRealm.discover(function(err) {
      if (err) {
        innerCallback(err);
        return;
      }

      switch(self._userRealm.accountType) {
        case AccountType.Managed:
          self._getTokenUsernamePasswordManaged(username, password, innerCallback);
          return;
        case AccountType.Federated:
          self._getTokenUsernamePasswordFederated(username, password, innerCallback);
          return;
        default:
          innerCallback(self._log.createError('Server returned an unknown AccountType: ' + self._userRealm.AccountType));
      }
    });
  });
};

/**
 * Obtains a token using client credentials
 * @private
 * @param  {string}   clientSecret
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype.getTokenWithClientCredentials = function(clientSecret, callback) {
  this._log.info('Getting token with client credentials.');

  this._getToken(callback, function(innerCallback) {
    var oauthParameters = this._createOAuthParameters(OAuth2GrantType.CLIENT_CREDENTIALS);

    oauthParameters[OAuth2Parameters.CLIENT_SECRET] = clientSecret;

    this._oauthGetToken(oauthParameters, innerCallback);
  });
};

/**
 * Obtains a token using an authorization code.
 * @private
 * @param  {string}   authorizationCode
 * @param  {string}   clientSecret
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype.getTokenWithAuthorizationCode = function(authorizationCode, clientSecret, callback) {
  this._log.info('Getting token with auth code.');
  var oauthParameters = this._createOAuthParameters(OAuth2GrantType.AUTHORIZATION_CODE);

  oauthParameters[OAuth2Parameters.CODE] = authorizationCode;
  oauthParameters[OAuth2Parameters.CLIENT_SECRET] = clientSecret;

  this._oauthGetToken(oauthParameters, callback);
};

/**
 * Obtains a token using a refresh token.
 * @param  {string}   refreshToken
 * @param  {string}   resource
 * @param  {string}   [clientSecret]
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype._getTokenWithRefreshToken = function(refreshToken, resource, clientSecret, callback) {
  this._log.info('Getting a new token from a refresh token.');
  var oauthParameters = this._createOAuthParameters(OAuth2GrantType.REFRESH_TOKEN);

  if (resource) {
    oauthParameters[OAuth2Parameters.RESOURCE] = resource;
  }

  if (clientSecret) {
    oauthParameters[OAuth2Parameters.CLIENT_SECRET] = clientSecret;
  }

  oauthParameters[OAuth2Parameters.REFRESH_TOKEN] = refreshToken;

  this._oauthGetToken(oauthParameters, callback);
};

/**
 * Obtains a token using a refresh token.
 * @param  {string}   refreshToken
 * @param  {string}   [clientSecret]
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype.getTokenWithRefreshToken = function(refreshToken, clientSecret, callback) {
  this._getTokenWithRefreshToken(refreshToken, null, clientSecret, callback);
};

/**
 * Obtains a token from the cache, refreshing it or using a MRRT if necessary.
 * @param {string}  [userId] The user associated with the cached token.
 * @param  {AcquireTokenCallback} callback
 */
TokenRequest.prototype.getTokenFromCacheWithRefresh = function(userId, callback) {
  var self = this;
  this._log.info('Getting token from cache with refresh if necessary.');

  this._userId = userId;
  this._getToken(callback, function(innerCallback){
    // If this method was called then no cached entry was found.  Since
    // this particular version of acquireToken can only retrieve tokens
    // from the cache, return an error.
    innerCallback(self._log.createError('Entry not found in cache.'));
  });
};

module.exports = TokenRequest;