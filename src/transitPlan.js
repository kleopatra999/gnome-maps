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

const _ = imports.gettext.gettext;
const N_ = imports.gettext.dgettext;

const Champlain = imports.gi.Champlain;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

// in org.gnome.desktop.interface
const CLOCK_FORMAT_KEY = 'clock-format';

let _desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
let clockFormat = _desktopSettings.get_string(CLOCK_FORMAT_KEY);


/*
 * These constants corresponds to the routeType attribute of transit legs
 * in the OpenTripPlanner API.
 */
const RouteType = {
    NON_TRANSIT: -1,
    TRAM:        0,
    SUBWAY:      1,
    TRAIN:       2,
    BUS:         3,
    FERRY:       4,
    /* Cable car referres to street-level cabel cars, where the propulsive
     * cable runs in a slot between the tracks beneeth the car
     * https://en.wikipedia.org/wiki/Cable_car_%28railway%29
     * For example the cable cars in San Fransisco
     * https://en.wikipedia.org/wiki/San_Francisco_cable_car_system
     */
    CABLE_CAR:   5,
    /* Gondola referres to a suspended cable car, typically aerial cable cars
     * where the car is suspended from the cable
     * https://en.wikipedia.org/wiki/Gondola_lift
     * For example the "Emirates Air Line" in London
     * https://en.wikipedia.org/wiki/Emirates_Air_Line_%28cable_car%29
     */
    GONDOLA:     6,
    /* Funicular referres to a railway system designed for steep inclines,
     * https://en.wikipedia.org/wiki/Funicular
     */
    FUNICULAR:   7
};

/* extra time to add to the first itinerary leg when it's a walking leg */
const WALK_SLACK = 120;

const Plan = new Lang.Class({
    Name: 'Plan',
    Extends: GObject.Object,
    Signals: {
        'update': {},
        'reset': {}
    },

    _init: function(params) {
        this.parent(params);
        this.reset();
    },

    get itineraries() {
        return this._itineraries;
    },

    update: function(itineraries) {
        this._itineraries = itineraries;
        this.bbox = this._createBBox();
        this.emit('update');
    },

    reset: function() {
        this._itineraries = [];
        this.bbox = null;
        this.emit('reset');
    },

    _createBBox: function() {
        let bbox = new Champlain.BoundingBox();
        this._itineraries.forEach(function(itinerary) {
            itinerary.legs.forEach(function(leg) {
                bbox.extend(leg.fromCoordinate[0],
                            leg.fromCoordinate[1]);
                bbox.extend(leg.toCoordinate[0],
                            leg.toCoordinate[1]);
            });
        });
        return bbox;
    }
});

const Itinerary = new Lang.Class({
    Name: 'Itinerary',

    _init: function(params) {
        this._duration = params.duration;
        delete params.duration;

        this._departure = params.departure;
        delete params.departure;

        this._arrival = params.arrival;
        delete params.arrival;

        this._transfers = params.transfers;
        delete params.transfers;

        this._legs = params.legs;
        delete params.legs;
    },

    get duration() {
        return this._duration;
    },

    get departure() {
        return this._departure;
    },

    get arrival() {
        return this._arrival;
    },

    get transfers() {
        return this._transfers;
    },

    get legs() {
        return this._legs;
    },

    /* adjust timings of the legs of the itinerary, using the real duration of
     * walking legs, also sets the timezone offsets according to adjacent
     * transit legs */
    _adjustLegTimings: function() {
        if (this.legs.length === 1 && !this.legs[0].transit) {
            /* if there is only one leg, and it's a walking one, just need to
             * adjust the arrival time */
            let leg = this.legs[0];
            leg.arrival = leg.departure + leg.duration * 1000;

            return;
        }

        for (let i = 0; i < this.legs.length; i++) {
            let leg = this.legs[i];

            if (!leg.transit) {
                if (i === 0) {
                    /* for the first leg subtract the walking time plus a
                     * safty slack from the departure time of the following
                     * leg */
                    let nextLeg = this.legs[i + 1];
                    leg.departure =
                        nextLeg.departure - leg.duration * 1000 - WALK_SLACK;
                    leg.arrival = leg.departure + leg.duration * 1000;
                    /* use the timezone offset from the first transit leg */
                    leg.agencyTimezoneOffset = nextLeg.agencyTimezoneOffset;
                } else {
                    /* for walking legs in the middle or at the end, just add
                     * the actual walking walk duration to the arrival time of
                     * the previous leg */
                    let previousLeg = this.legs[i - 1];
                    leg.arrival = previousLeg.arrival + leg.duration * 1000;
                    /* use the timezone offset of the previous (transit) leg */
                    leg.agencyTimezoneOffset = previousLeg.agencyTimezoneOffset;
                }
            }
        }
    },

    prettyPrintTimeInterval: function() {
        /* Translators: this is a format string for showing a departure and
         * arrival time, like:
         * "12:00 — 13:03" where the placeholder %s are the actual times,
         * these could be rearranged if needed */
        return _("%s \u2014 %s").format(this._getDepartureTime(),
                                        this._getArrivalTime());
    },

    _getDepartureTime: function() {
        /* take the itinerary departure time and offset using the timezone
         * offset of the first leg */
        let utcTimeWithOffset =
            (this.departure +
             this.legs[0].agencyTimezoneOffset) / 1000;
        let date = GLib.DateTime.new_from_unix_utc(utcTimeWithOffset);

        if (clockFormat === '24h')
            return date.format('%R');
        else
            return date.format('%r');
    },

    _getArrivalTime: function() {
        /* take the itinerary departure time and offset using the timezone
         * offset of the first leg */
        let utcTimeWithOffset =
            (this.arrival +
             this.legs[this.legs.length - 1].agencyTimezoneOffset) / 1000;
        let date = GLib.DateTime.new_from_unix_utc(utcTimeWithOffset);

        if (clockFormat === '24h')
            return date.format('%R');
        else
            return date.format('%r');
    },

    prettyPrintDuration: function() {
        let mins = this.duration / 60;

        if (mins < 60) {
            return N_("%d minute", "%d minutes", mins).format(mins);
        } else {
            let hours = Math.floor(mins / 60);

            mins = mins % 60;

            if (mins === 0)
                return N_("%d hour", "%d hours", d).format(hours);
            else
                return N_("%d:%d hour", "%d:%d hours", hours).format(hours, mins);
        }
    },

    adjustTimings: function() {
        this._adjustLegTimings();
        this._departure = this._legs[0].departure;
        this._arrival = this._legs[this._legs.length - 1].arrival;
        this._duration = (this._arrival - this._departure) / 1000;
    },

    toString: function() {
        let start = new Date();
        let end = new Date();
        let durationString =
            this.duration >= 60 * 60 ? '%d h %d min'.format(this.duration / (60 * 60),
                                                            this.duration % (60 * 60) / 60) :
                                       '%d min'.format(this.duration / 60);
        start.setTime(this.departure);
        end.setTime(this.arrival);
        return 'Itinerary: \nDeparture: ' + start + '\nArrival: ' + end +
               '\nduration: ' + durationString + ', ' + this.transfers + ' transfers';
    }
});

const Leg = new Lang.Class({
    Name: 'Leg',

    _init: function(params) {
        this._route = params.route;
        delete params.route;

        this._routeType = params.routeType;
        delete params.routeType;

        this._departure = params.departure;
        delete params.departure;

        this._arrival = params.arrival;
        delete params.arrival;

        this._polyline = params.polyline;
        delete params.polyline;

        this._fromCoordinate = params.fromCoordinate;
        delete params.fromCoordinate;

        this._toCoordinate = params.toCoordinate;
        delete params.toCoordinate;

        this._from = params.from;
        delete params.from;

        this._to = params.to;
        delete params.to;

        this._intermediateStops = params.intermediateStops;
        delete params.intermediateStops;

        this._headSign = params.headSign;
        delete params.headSign;

        this._isTransit = params.isTransit;
        delete params.isTransit;

        this._walkingInstructions = params.walkingInstructions;
        delete params.walkingInstructions;

        this._distance = params.distance;
        delete params.distance;

        this._duration = params.duration;
        delete params.duration;

        this._agencyName = params.agencyName;
        delete params.agencyName;

        this._agencyUrl = params.agencyUrl;
        delete params.agencyUrl;

        this._agencyTimezoneOffset = params.agencyTimezoneOffset;
        delete params.agencyTimezoneOffset;

        this._color = params.color;
        delete params.color;

        this._textColor = params.textColor;
        delete params.textColor;

        this._tripShortName = params.tripShortName;
        delete params.tripShortName;
    },

    get route() {
        return this._route;
    },

    get routeType() {
        return this._routeType;
    },

    get departure() {
        return this._departure;
    },

    set departure(departure) {
        this._departure = departure;
    },

    get arrival() {
        return this._arrival;
    },

    set arrival(arrival) {
        this._arrival = arrival;
    },

    get polyline() {
        return this._polyline;
    },

    get fromCoordinate() {
        return this._fromCoordinate;
    },

    get toCoordinate() {
        return this._toCoordinate;
    },

    get from() {
        return this._fromName;
    },

    get to() {
        return this._toName;
    },

    get intermediateStops() {
        return this._intermediateStops;
    },

    get headSign() {
        return this._headSign;
    },

    get transit() {
        return this._isTransit;
    },

    get distance() {
        return this._distance;
    },

    get duration() {
        return this._duration;
    },

    get agencyName() {
        return this._agencyName;
    },

    get agencyUrl() {
        return this._agencyUrl;
    },

    get agencyTimezoneOffset() {
        return this._agencyTimezoneOffset;
    },

    set agencyTimezoneOffset(tzOffset) {
        this._agencyTimezoneOffset = tzOffset;
    },

    get color() {
        return this._color;
    },

    get textColor() {
        return this._textColor;
    },

    get tripShortName() {
        return this._tripShortName;
    },

    get iconName() {
        if (this._isTransit) {
            switch (this._routeType) {
            case RouteType.TRAM:
                return 'route-transit-tram-symbolic';
            case RouteType.SUBWAY:
                return 'route-transit-subway-symbolic';
            case RouteType.TRAIN:
                return 'route-transit-train-symbolic';
            case RouteType.BUS:
                return 'route-transit-bus-symbolic';
            case RouteType.FERRY:
                return 'route-transit-ferry-symbolic';
            case RouteType.CABLE_CAR:
                return 'route-transit-cablecar-symbolic';
            case RouteType.GONDOLA:
                return 'route-transit-gondolalift-symbolic';
            case RouteType.FUNICULAR:
                return 'route-transit-funicular-symbolic';
            default:
                /* use a fallback question mark icon in case of some future,
                 * for now unknown mode appears */
                return 'dialog-question-symbolic';
            }
        } else {
            return 'route-pedestrian-symbolic';
        }
    }
});

const Stop = new Lang.Class({
    Name: 'Stop',

    _init: function(params) {
        this._name = params.name;
        delete params.name;

        this._arrival = params.arrival;
        delete params.arrival;

        this._coordinate = params.coordinate;
        delete params.coordinate;
    },

    get name() {
        return this._name;
    },

    get arrival() {
        return this._arrival;
    },

    get coordinate() {
        return this._coordinate;
    }
});

function compareItineries(first, second) {
    return first.departure > second.departure;
}
