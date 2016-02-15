/* -*- Mode: JS2; indent-tabs-mode: nil; js2-basic-offset: 4 -*- */
/* vim: set et ts=4 sw=4: */
/*
 * Copyright (c) 2016 Marcus Lundblad
 *
 * GNOME Maps is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * GNOME Maps is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with GNOME Maps; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Author: Marcus Lundblad <ml@update.uu.se>
 */

const Lang = imports.lang;

const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;

const Application = imports.application;
const EPAF = imports.epaf;
const HTTP = imports.http;
const Location = imports.location;
const Place = imports.place;
const RouteQuery = imports.routeQuery;
const TransitPlan = imports.transitPlan;
const Utils = imports.utils;

/* base URL used for testing against a local OTP instance for now */
const BASE_URL = 'http://localhost:8080/otp';

/* timeout after which the routers data is considered stale and we will force
 * a reload (24 hours) */
const ROUTERS_TIMEOUT = 24 * 60 * 60 * 1000;

/* minimum distance when an explicit walk route will be requested to suppliment
 * the transit route */
const MIN_WALK_ROUTING_DISTANCE = 100;

/* minimum distance of a transit leg, below which we would replace the leg with
 * walking if the leg is the first or last */
const MIN_TRANSIT_LEG_DISTANCE = 300;

/* maximum walking distance for a potential replacement of a beginning or ending
 * transit leg */
const MAX_WALK_OPTIMIZATION_DISTANCE = 1000;

/* maximum distance difference for performing a replacement of a beginning or
 * ending transit leg with a walking leg */
const MAX_WALK_OPTIMIZATION_DISTANCE_DIFFERENCE = 300;

/* minimum acceptable time margin when recalculating walking legs in the middle
 * of an itinerary */
const MIN_INTERMEDIATE_WALKING_SLACK = 120;

const OpenTripPlanner = new Lang.Class({
    Name: 'OpenTripPlanner',

    _init: function() {
        this._session = new Soup.Session();
        /* initially set routers as updated far back in the past to force
         * a download when first request */
        this._routersUpdatedTimestamp = 0;
        this._query = Application.routeQuery;
        this._plan = new TransitPlan.Plan();
    },

    get plan() {
        return this._plan;
    },

    connect: function() {
        this._signalHandler = this._query.connect('notify::points', (function() {
            if (this._query.isValid())
                this.fetchRoute();
        }).bind(this));
    },

    disconnect: function() {
        if (this._signalHandler !== 0) {
            this._query.disconnect(this._signalHandler);
            this._signalHandler = 0;
        }
    },

    _getBaseUrl: function() {
        let debugUrl = GLib.getenv('OTP_BASE_URL');

        return debugUrl ? debugUrl : BASE_URL;
    },

    _fetchRouters: function(callback) {
        let currentTime = (new Date()).getTime();

        if (currentTime - this._routersUpdatedTimestamp < ROUTERS_TIMEOUT) {
            callback(true);
        } else {
            let uri = new Soup.URI(this._getBaseUrl() + '/routers');
            let request = new Soup.Message({ method: 'GET', uri: uri });

            request.request_headers.append('Accept', 'application/json');
            this._session.queue_message(request, (function(obj, message) {
                if (message.status_code !== Soup.Status.OK) {
                    callback(false);
                    return;
                }

                Utils.debug('routers: ' + message.response_body.data);
                try {
                    this._routers = JSON.parse(message.response_body.data);
                    this._routersUpdatedTimestamp = (new Date()).getTime();
                    callback(true);
                } catch (e) {
                    Utils.debug('Failed to parse router information');
                    callback(false);
                }
            }).bind(this));
        }
    },

    _getRoutersForPlace: function(place) {
        let routers = [];

        Utils.debug('_getRotersForPlace');
        Utils.debug('place coords: ' + place.location.latitude + ', ' + place.location.longitude);

        this._routers.routerInfo.forEach((function(routerInfo) {
            Utils.debug('checking router: ' + routerInfo.routerId);

            /* TODO: only check bounding rectangle for now
             * should we try to do a finer-grained check using the bounding
             * polygon (if OTP gives one for the routers).
             * And should we add some margins to allow routing from just outside
             * a network (walking distance)? */
            if (place.location.latitude >= routerInfo.lowerLeftLatitude &&
                place.location.latitude <= routerInfo.upperRightLatitude &&
                place.location.longitude >= routerInfo.lowerLeftLongitude &&
                place.location.longitude <= routerInfo.upperRightLongitude)
                routers.push(routerInfo.routerId);
        }));

        return routers;
    },

    /* Note: this is theoretically slow (O(n*m)), but we will have filtered
     * possible routers for the starting and ending query point, so they should
     * be short (in many cases just one element) */
    _routerIntersection: function(routers1, routers2) {
        return routers1.filter(function(n) {
            return routers2.indexOf(n) != -1;
        });
    },

    _formatPlaceQueryParam: function(place) {
        return '%s,%s'.format(place.location.latitude, place.location.longitude);
    },

    _getMode: function(routeType) {
        switch (routeType) {
        case TransitPlan.RouteType.TRAM:
            return 'TRAM';
        case TransitPlan.RouteType.TRAIN:
            return 'RAIL';
        case TransitPlan.RouteType.SUBWAY:
            return 'SUBWAY';
        case TransitPlan.RouteType.BUS:
            return 'BUS';
        case TransitPlan.RouteType.FERRY:
            return 'FERRY';
        }
    },

    _getModes: function(options) {
        let modes = options.showRouteTypes.map((function(routeType) {
            return this._getMode(routeType);
        }).bind(this));

        return modes.join(',');
    },

    _fetchRoutesRecursive: function(routers, index, result, callback) {
        let points = this._query.filledPoints;
        let params = {fromPlace: this._formatPlaceQueryParam(points[0].place),
                      toPlace: this._formatPlaceQueryParam(points[points.length - 1].place)
                      };

        Utils.debug('fetching plans for router with index ' + index);
        Utils.debug('number of points: ' + points.length);

        let intermediatePlaces = [];
        for (let i = 1; i < points.length - 1; i++) {
            Utils.debug('intermediatePlace: ' + this._formatPlaceQueryParam(points[i].place));
            intermediatePlaces.push(this._formatPlaceQueryParam(points[i].place));
        }
        if (intermediatePlaces.length > 0)
            params.intermediatePlaces = intermediatePlaces;

        Utils.debug('intermediatePlaces: ' + intermediatePlaces);

        params.numItineraries = 5;
        params.walkReluctance = 5;
        params.showIntermediateStops = true;
        //params.walkSpeed = 1.0;

        let time = this._query.time;
        let date = this._query.date;

        if (time) {
            params.time = time;
            /* it seems OTP doesn't like just setting a time, so if the query
             * doesn't specify a date, go with today's date */
            if (!date) {
                let dateTime = GLib.DateTime.new_now_local();

                params.date = dateTime.format('%F');
            }
        }

        if (date)
            params.date = date;

        let arriveBy = this._query.arriveBy;
        if (arriveBy)
            params.arriveBy = true;

        let options = this._query.transitOptions;
        if (options) {
            if (!options.showAllRouteTypes)
                params.mode = this._getModes(options);
        }

        let query = new HTTP.Query(params);
        let uri = new Soup.URI(this._getBaseUrl() + '/routers/' + routers[index] +
                               '/plan?' + query.toString());
        let request = new Soup.Message({ method: 'GET', uri: uri });

        Utils.debug('URI: ' + uri.to_string(true));

        request.request_headers.append('Accept', 'application/json');
        this._session.queue_message(request, (function(obj, message) {
            Utils.debug('callback: ' + callback);
            if (message.status_code !== Soup.Status.OK)
                Utils.debug('Failed to get route plan from router ' +
                            routers[index]);
            else
                result.push(JSON.parse(message.response_body.data))

            if (index < routers.length - 1)
                this._fetchRoutesRecursive(routers, index + 1, result,
                                           callback);
            else {
                Utils.debug('calling callback at index ' + index);
                callback(result);
            }
        }).bind(this));
    },

    _fetchRoutes: function(routers, callback) {
        Utils.debug('_fetchRoutes with length: ' + routers.length);
        this._fetchRoutesRecursive(routers, 0, [], callback);
    },

    _reset: function() {
        if (this._query.latest)
            this._query.latest.place = null;
        else
            this.plan.reset();
    },

    fetchRoute: function() {
        this._fetchRouters((function(success) {
            if (success) {
                let points = this._query.filledPoints;
                let routers = this._getRoutersForPoints(points);

                if (routers.length > 0) {
                    Utils.debug('about to fetch routes');
                    this._fetchRoutes(routers, (function(routes) {
                        let itineraries = [];
                        routes.forEach((function(plan) {
                            Utils.debug('plan: ' + JSON.stringify(plan, null, 2));
                            if (plan.plan && plan.plan.itineraries) {
                                Utils.debug('creating itineraries');
                                itineraries =
                                    itineraries.concat(
                                        this._createItineraries(plan.plan.itineraries));
                                Utils.debug('itineraries.length: ' + itineraries.length);
                            }
                        }).bind(this));
                        Utils.debug('found ' + itineraries.length + ' itineraries');
                        if (itineraries.length === 0) {
                            Application.notificationManager.showMessage(_("No route found."));
                            this._reset();
                        } else {
                            this._recalculateItineraries(itineraries);
                        }
                    }).bind(this));

                } else {
                    Application.notificationManager.showMessage(_("No timetable data found for this route."));
                    this._reset();
                }
            } else {
                Application.notificationManager.showMessage(_("Route request failed."));
                this._reset();
            }
        }).bind(this));
    },

    _isOnlyWalkingItinerary: function(itinerary) {
        return itinerary.legs.length === 1 && !itinerary.legs[0].transit;
    },

    _recalculateItineraries: function(itineraries) {
        /* when the only found option is a walking route, OTP seems to return
         * back multiple identical itineraries (as many as the requested number
         * of itineraries), so to avoid duplicates (and saving extanous queries
         * to GraphHopper when recalculating walking legs) prune it down to just
         * one itiner in this case. */
        let onlyWalking = false;

        itineraries.forEach((function(itinerary) {
            onlyWalking = this._isOnlyWalkingItinerary(itinerary);
        }).bind(this));

        if (onlyWalking) {
            itineraries = [itineraries[0]];
        }

        this._recalculateItinerariesRecursive(itineraries, 0);
    },

    _isItineraryRealistic: function(itinerary) {
        let realistic = true;

        /* check walking legs "inside" the itinerary */
        for (let i = 1; i < itinerary.legs.length - 1; i++) {
            let leg = itinerary.legs[i];

            if (!leg.transit) {
                let previousLeg = itinerary.legs[i - 1];
                let nextLeg = itinerary.legs[i + 1];

                let availableTime =
                    (nextLeg.departure - previousLeg.arrival) / 1000;

                Utils.debug('checking if waking leg is realistic');
                Utils.debug('available time: ' + availableTime);
                Utils.debug('duration of walking leg: ' + leg.duration);

                realistic = availableTime >= leg.duration +
                                             MIN_INTERMEDIATE_WALKING_SLACK;
            }
        }

        return realistic;
    },

    _recalculateItinerariesRecursive: function(itineraries, index) {
        if (index < itineraries.length) {
            Utils.debug('recalculating itinerary ' + index);
            this._recalculateItinerary(itineraries[index], (function(itinerary) {
                itineraries[index] = itinerary;
                Utils.debug('about to recalculate itinerary for index ' + (index + 1));
                this._recalculateItinerariesRecursive(itineraries, index + 1);
            }).bind(this));
        } else {
            /* filter out itineraries where there are intermediate walking legs
             * that are too narrow time-wise, this is nessesary since running
             * OTP with only transit data can result in some over-optimistic
             * walking itinerary legs, since it will use "line-of-sight"
             * distances */
            let filteredItineraries = [];

            itineraries.forEach((function(itinerary) {
                if (this._isItineraryRealistic(itinerary))
                    filteredItineraries.push(itinerary);
            }).bind(this));

            if (filteredItineraries.length > 0) {
                filteredItineraries.forEach((function(itinerary) {
                    itinerary.adjustTimings();
                }).bind(this));

                /* sort itineraries, by departure time ascending if querying
                 * by leaving time, descending when querying by arriving time */
                filteredItineraries.sort(TransitPlan.compareItineries);
                if (this._query.arriveBy)
                    filteredItineraries.reverse();

                Utils.debug('found itineraries: ');
                filteredItineraries.forEach((function(itinerary) {
                    Utils.debug(itinerary.toString());
                }));

                this.plan.update(filteredItineraries);
            } else {
                Application.notificationManager.showMessage(_("No route found."));
                this._reset();
            }
        }
    },

    _createWalkingLeg: function(from, to, route) {
        let polyline = EPAF.decode(route.paths[0].points);

        return new TransitPlan.Leg({fromCoordinate:      [from.place.location.latitude,
                                                          from.place.location.longitude],
                                    toCoordinate:        [to.place.location.latitude,
                                                          to.place.location.longitude],
                                    isTransit:           false,
                                    polyline:            polyline,
                                    duration:            route.paths[0].time / 1000,
                                    walkingInstructions: route.paths[0]});
    },

    _recalculateItinerary: function(itinerary, callback) {
        let from = this._query.filledPoints[0];
        let to = this._query.filledPoints[this._query.filledPoints.length - 1];

        if (itinerary.legs.length === 1 && !itinerary.legs[0].transit) {
            /* special case, if there's just one leg of an itinerary, and that leg
             * leg is a non-transit (walking), recalculate the route in its entire
             * using walking */
            Application.routeService.fetchRouteAsync(this._query.filledPoints,
                                                     RouteQuery.Transportation.PEDESTRIAN,
                                                     (function(route) {
                Utils.debug('Walking route: ' + JSON.stringify(route, '', 2));
                let leg = this._createWalkingLeg(from, to, route);
                let newItinerary =
                    new TransitPlan.Itinerary({departure: itinerary.departure,
                                               duration: route.paths[0].time / 1000,
                                               legs: [leg]});
                callback(newItinerary);
            }).bind(this));
        } else if (itinerary.legs.length === 1 && itinerary.legs[0].transit) {
            /* special case if there is extactly one transit leg */
            let startLeg =
                this._createQueryPointForCoord(itinerary.legs[0].fromCoordinate);
            let endLeg =
                this._createQueryPointForCoord(itinerary.legs[0].toCoordinate);
            let fromLoc = from.place.location;
            let startLoc = startLeg.place.location;
            let endLoc = endLeg.place.location;
            let toLoc = to.place.location;
            let startWalkDistance = fromLoc.get_distance_from(startLoc) * 1000;
            let endWalkDistance = endLoc.get_distance_from(toLoc) * 1000;

            Utils.debug('startWalkDistance: ' + startWalkDistance);
            Utils.debug('endWalkDistance: ' + endWalkDistance);

            if (startWalkDistance >= MIN_WALK_ROUTING_DISTANCE &&
                endWalkDistance >= MIN_WALK_ROUTING_DISTANCE) {
                /* add an extra walking leg to both the beginning and end of the
                 * itinerary */
                Application.routeService.fetchRouteAsync([from, startLeg],
                                                         RouteQuery.Transportation.PEDESTRIAN,
                                                         (function(firstRoute) {
                    let firstLeg =
                        this._createWalkingLeg(from, startLeg, firstRoute);
                    Application.routeService.fetchRouteAsync([endLeg, to],
                                                             RouteQuery.Transportation.PEDESTRIAN,
                                                             (function(lastRoute) {
                        Utils.debug('lastRoute: ' + lastRoute);
                        let lastLeg =
                            this._createWalkingLeg(endLeg, to, lastRoute);
                        itinerary.legs.unshift(firstLeg);
                        itinerary.legs.push(lastLeg);
                        callback(itinerary);
                    }).bind(this));
                }).bind(this));
            } else if (endWalkDistance >= MIN_WALK_ROUTING_DISTANCE) {
                /* add an extra walking leg to the end of the itinerary */
                Application.routeService.fetchRouteAsync([endLeg, to],
                                                         RouteQuery.Transportation.PEDESTRIAN,
                                                         (function(lastRoute) {
                    let lastLeg =
                        this._createWalkingLeg(endLeg, to, lastRoute);
                    itinerary.legs.push(lastLeg);
                    callback(itinerary);
                }).bind(this));
            } else {
                /* if only there's only a walking leg to be added to the start
                 * let the recursive routine dealing with multi-leg itineraries
                 * handle it */
                this._recalculateItineraryRecursive(itinerary, 0, callback);
            }
        } else {
            /* replace walk legs with GraphHopper-generated paths (hence the
             * callback nature of this. Filter out unrealistic itineraries (having
             * walking segments not possible in reasonable time, due to our running
             * of OTP with only transit data). */
            this._recalculateItineraryRecursive(itinerary, 0, callback);
        }
    },

    _createQueryPointForCoord: function(coord) {
        let location = new Location.Location({ latitude: coord[0],
                                               longitude: coord[1],
                                               accuracy: 0 });
        let place = new Place.Place({ location: location });
        let point = new RouteQuery.QueryPoint();

        point.place = place;
        return point;
    },

    _recalculateItineraryRecursive: function(itinerary, index, callback) {
        if (index < itinerary.legs.length) {
            let leg = itinerary.legs[index];
            if (index === 0) {
                Utils.debug('recalculate first leg');
                let from = this._query.filledPoints[0];
                let startLeg =
                    this._createQueryPointForCoord(leg.fromCoordinate);
                let endLeg =
                    this._createQueryPointForCoord(leg.toCoordinate);
                let fromLoc = from.place.location;
                let startLegLoc = startLeg.place.location;
                let endLegLoc = endLeg.place.location;
                let distanceToEndLeg =
                    fromLoc.get_distance_from(endLegLoc) * 1000;
                let distanceToStartLeg =
                    fromLoc.get_distance_from(startLegLoc) * 1000;

                if (!leg.transit ||
                    (leg.distance <= MIN_TRANSIT_LEG_DISTANCE ||
                     (distanceToEndLeg <= MAX_WALK_OPTIMIZATION_DISTANCE &&
                      distanceToEndLeg - distanceToStartLeg <=
                      MAX_WALK_OPTIMIZATION_DISTANCE_DIFFERENCE))) {
                    /* if the first leg of the intinerary returned by OTP is a
                     * walking one, recalculate it with GH using the actual
                     * starting coordinate from the input query,
                     * also replace a transit leg at the start with walking if
                     * its distance is below a threashhold, to avoid suboptimal
                     * routes due to only running OTP with transit data,
                     * also optimize away cases where the routing would make one
                     * "pass by" a stop at the next step in the itinerary due to
                     * similar reasons */
                    Utils.debug('query point coords: ' +
                                leg.toCoordinate[0] + ', ' + leg.toCoordinate[1]);
                    let to = this._createQueryPointForCoord(leg.toCoordinate);
                    Application.routeService.fetchRouteAsync([from, to],
                                                             RouteQuery.Transportation.PEDESTRIAN,
                                                             (function(route) {
                        let newLeg = this._createWalkingLeg(from, to, route);
                        itinerary.legs[index] = newLeg;
                        this._recalculateItineraryRecursive(itinerary, index + 1,
                                                            callback);
                    }).bind(this));
                } else {
                    /* introduce an additional walking leg calculated
                     * by GH in case the OTP starting point as far enough from
                     * the original starting point */
                    let to = this._createQueryPointForCoord(leg.fromCoordinate);
                    let fromLoc = from.place.location;
                    let toLoc = to.place.location;
                    let distance = fromLoc.get_distance_from(toLoc) * 1000;
                    Utils.debug('distance from original starting point to start of transit route: ' + distance);

                    if (distance >= MIN_WALK_ROUTING_DISTANCE) {
                        Application.routeService.fetchRouteAsync([from, to],
                                                                 RouteQuery.Transportation.PEDESTRIAN,
                                                                 (function(route) {
                            let newLeg = this._createWalkingLeg(from, to, route);
                            itinerary.legs.unshift(newLeg);
                            /* now, next index will be two steps up, since we
                             * inserted a new leg */
                            this._recalculateItineraryRecursive(itinerary,
                                                                index + 2,
                                                                callback);
                        }).bind(this));
                    } else {
                        this._recalculateItineraryRecursive(itinerary, index + 1,
                                                            callback);
                    }
                }
            } else if (index === itinerary.legs.length - 1) {
                Utils.debug('recalculate final leg');
                let to = this._query.filledPoints[this._query.filledPoints.length - 1];
                let startLeg =
                    this._createQueryPointForCoord(leg.fromCoordinate);
                let endLeg = this._createQueryPointForCoord(leg.toCoordinate);
                let toLoc = to.place.location;
                let startLegLoc = startLeg.place.location;
                let endLegLoc = endLeg.place.location;
                let distanceFromEndLeg =
                    toLoc.get_distance_from(endLegLoc) * 1000;
                let distanceFromStartLeg =
                    toLoc.get_distance_from(startLegLoc) * 1000;

                if (!leg.transit ||
                    (leg.distance <= MIN_TRANSIT_LEG_DISTANCE ||
                     (distanceFromStartLeg <= MAX_WALK_OPTIMIZATION_DISTANCE &&
                      distanceFromStartLeg - distanceFromEndLeg <=
                      MAX_WALK_OPTIMIZATION_DISTANCE_DIFFERENCE))) {
                    /* if the final leg of the itinerary returned by OTP is a
                     * walking one, recalculate it with GH using the actual
                     * ending coordinate from the input query
                     * also replace a transit leg at the end with walking if
                     * its distance is below a threashhold, to avoid suboptimal
                     * routes due to only running OTP with transit data,
                     * also optimize away cases where the routing would make one
                     * "pass by" a stop at the previous step in the itinerary
                     * due to similar reasons */
                    Utils.debug('non-transit leg');
                    let from = this._createQueryPointForCoord(leg.fromCoordinate);
                    Application.routeService.fetchRouteAsync([from, to],
                                                             RouteQuery.Transportation.PEDESTRIAN,
                                                             (function(route) {
                        let newLeg = this._createWalkingLeg(from, to, route);
                        Utils.debug('Created walking leg');
                        itinerary.legs[index] = newLeg;
                        this._recalculateItineraryRecursive(itinerary, index + 1,
                                                            callback);
                    }).bind(this));
                } else {
                    /* introduce an additional walking leg calculated by GH in
                     * case the OTP end point as far enough from the original
                     * end point */
                    let from = this._createQueryPointForCoord(leg.toCoordinate);
                    let fromLoc = from.place.location;
                    let toLoc = to.place.location;
                    let distance = fromLoc.get_distance_from(toLoc) * 1000;

                    Utils.debug('distance: ' + distance);

                    if (distance >= MIN_WALK_ROUTING_DISTANCE) {
                        Application.routeService.fetchRouteAsync([from, to],
                                                                 RouteQuery.Transportation.PEDESTRIAN,
                                                                 (function(route) {
                            let newLeg = this._createWalkingLeg(from, to, route);
                            itinerary.legs.push(newLeg);
                            /* now, next index will be two steps up, since we
                             * inserted a new leg */
                            this._recalculateItineraryRecursive(itinerary,
                                                                 index + 2,
                                                                 callback);
                        }).bind(this));
                    } else {
                        this._recalculateItineraryRecursive(itinerary, index + 1,
                                                            callback);
                    }
                }
            } else {
                /* if an intermediate leg is a walking one, and it's distance is
                 * above the threashhold distance, calculate an exact route */
                Utils.debug('recalculate in-between leg');
                if (!leg.transit && leg.distance >= MIN_WALK_ROUTING_DISTANCE) {
                    let from = this._createQueryPointForCoord(leg.fromCoordinate);
                    let to = this._createQueryPointForCoord(leg.toCoordinate);
                    Application.routeService.fetchRouteAsync([from, to],
                                                             RouteQuery.Transportation.PEDESTRIAN,
                                                             (function(route) {
                        let newLeg = this._createWalkingLeg(from, to, route);
                        itinerary.legs[index] = newLeg;
                        this._recalculateItineraryRecursive(itinerary,
                                                            index + 1,
                                                            callback);
                    }).bind(this));
                } else {
                    this._recalculateItineraryRecursive(itinerary, index + 1,
                                                        callback);
                }
            }
        } else {
            Utils.debug('Finished recursive recalculation of itinerary');
            callback(itinerary);
        }
    },

    _getRoutersForPoints: function(points) {
        Utils.debug('sucessfully fetched routers list, points.length ' + points.length);
        let startRouters = this._getRoutersForPlace(points[0].place);
        let endRouters =
            this._getRoutersForPlace(points[points.length - 1].place);

        Utils.debug('routers at start point: ' + startRouters);
        Utils.debug('routers at end point: ' + endRouters);
        let intersectingRouters =
            this._routerIntersection(startRouters, endRouters);

        Utils.debug('intersecting routers: ' + intersectingRouters);

        return intersectingRouters;
    },

    _createItineraries: function(itineraries) {
        return itineraries.map((function(itinerary) {
                                    return this._createItinerary(itinerary);
                                }).bind(this));
    },

    _createItinerary: function(itinerary) {
        let legs = this._createLegs(itinerary.legs);
        return new TransitPlan.Itinerary({ duration:  itinerary.duration,
                                           transfers: itinerary.transfers,
                                           departure: itinerary.startTime,
                                           arrival:   itinerary.endTime,
                                           legs:      legs});
    },

    _createLegs: function(legs) {
        return legs.map((function(leg) {
            return this._createLeg(leg);
        }).bind(this));
    },

    _createLeg: function(leg) {
        let polyline = EPAF.decode(leg.legGeometry.points);
        let intermediateStops =
            this._createIntermediateStops(leg.intermediateStops);
        return new TransitPlan.Leg({ departure:            leg.from.departure,
                                     arrival:              leg.to.arrival,
                                     from:                 leg.from.name,
                                     to:                   leg.to.name,
                                     intermediateStops:    intermediateStops,
                                     fromCoordinate:       [leg.from.lat,
                                                            leg.from.lon],
                                     toCoordinate:         [leg.to.lat,
                                                            leg.to.lon],
                                     route:                leg.route,
                                     routeType:            leg.routeType,
                                     polyline:             polyline,
                                     isTransit:            leg.transitLeg,
                                     distance:             leg.distance,
                                     duration:             leg.duration,
                                     agencyName:           leg.agencyName,
                                     agencyUrl:            leg.agencyUrl,
                                     agencyTimezoneOffset: leg.agencyTimeZoneOffset,
                                     color:                leg.routeColor,
                                     textColor:            leg.routeTextColor,
                                     tripShortName:        leg.tripShortName });
    },

    _createIntermediateStops: function(stops) {
        return stops.map((function(stop) {
            return this._createIntermediateStop(stop);
        }).bind(this));
    },

    _createIntermediateStop: function(stop) {
        return new TransitPlan.Stop({ name:       stop.name,
                                      arrival:    stop.arrival,
                                      coordinate: [stop.lat, stop.lon] });
    }
})
