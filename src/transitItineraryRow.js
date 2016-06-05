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

const Gtk = imports.gi.Gtk;

const TransitRouteLabel = imports.transitRouteLabel;

const TransitItineraryRow = new Lang.Class({
    Name: 'TransitItineraryRow',
    Extends: Gtk.ListBoxRow,
    Template: 'resource:///org/gnome/Maps/ui/transit-itinerary-row.ui',
    InternalChildren: ['timeLabel',
                       'durationLabel',
                       'summaryGrid'],

    _init: function(params) {
        this._itinerary = params.itinerary;
        delete params.itinerary;

        this.parent(params);

        this._timeLabel.label = this._itinerary.prettyPrintTimeInterval();
        this._durationLabel.label = this._itinerary.prettyPrintDuration();

        this._populateSummary();
    },

    get itinerary() {
        return this._itinerary;
    },

    _populateSummary: function() {
        /* use compacted route labels when more than 2 legs, to avoid
         * overflowing the sidebar width */
        let useCompact = this._itinerary.legs.length > 2;
        /* don't show the route labels when there are more than 4 legs in an
         * itinerary */
        let useContractedLabels = this._itinerary.legs.length > 4;
        for (let i = 0; i < this._itinerary.legs.length; i++) {
            let leg = this._itinerary.legs[i];

            this._summaryGrid.add(this._createLeg(leg, useCompact,
                                                  useContractedLabels));
            if (i !== this._itinerary.legs.length - 1) {
                /* add a separator item between itinerary legs */
                this._summaryGrid.add(new Gtk.Label({ visible: true,
                                                      label: '-' }))
            }
        }
    },

    _createLeg: function(leg, useCompact, useContractedLabels) {
        if (!leg.transit || useContractedLabels) {
            /* if this is a non-transit leg (walking), or in case we should
             * display only a mode icon (to save space), insert a sole icon */
            return new Gtk.Image({ icon_name: leg.iconName,
                                   visible: true })
        } else {
            /* for transit legs put besides a short route label */
            let grid = new Gtk.Grid({ visible: true, column_spacing: 2 });

            grid.attach(new Gtk.Image({ icon_name: leg.iconName, visible: true }),
                        0, 0, 1, 1);
            grid.attach(new TransitRouteLabel.TransitRouteLabel({ leg: leg,
                                                                  compact: useCompact,
                                                                  visible: true }),
                        1, 0, 1, 1);

            return grid;
        }
    }
});
