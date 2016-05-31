/* -*- Mode: JS2; indent-tabs-mode: nil; js2-basic-offset: 4 -*- */
/* vim: set et ts=4 sw=4: */
/*
 * Copyright (c) 2016 Marcus Lundblad.
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
 * with GNOME Maps; if not, see <http://www.gnu.org/licenses/>.
 *
 * Author: Marcus Lundblad <ml@update.uu.se>
 */

const Lang = imports.lang;

const Cairo = imports.cairo;
const Gtk = imports.gi.Gtk;

const Utils = imports.utils;

/* default route label colors */
const DEFAULT_COLOR = "3465a4";
const DEFAULT_TEXT_COLOR = "ffffff";

/* threashhold for route color luminance when we consider it more or less
 * as white, and draw an outline around the label */
const OUTLINE_LUMINANCE_THREASHHOLD = 0.9;

const MIN_CONTRAST_RATIO = 4.0;

const TransitRouteLabel = new Lang.Class({
    Name: 'TransitRouteLabel',
    Extends: Gtk.Label,
    Template: 'resource:///org/gnome/Maps/ui/transit-route-label.ui',

    _init: function(params) {
        this._leg = params.leg;
        delete params.leg;

        this._compact = params.compact;
        delete params.compact;

        this.parent(params);

        this._setLabel();
        this.connect('draw', this._onDraw.bind(this));
    },

    _setLabel: function() {
        let color = this._leg.color;
        let textColor = this._leg.textColor;
        let label = this._leg.route;

        if (!color)
            color = DEFAULT_COLOR;

        if (!textColor)
            textColor = DEFAULT_TEXT_COLOR;

        if (Utils.contrastRatio(color, textColor) < MIN_CONTRAST_RATIO) {
            let contrastAgainstWhite = Utils.contrastRatio(color, 'ffffff');
            let contrastAgainstBlack = Utils.contrastRatio(color, '000000');

            if (contrastAgainstWhite > contrastAgainstBlack)
                textColor = 'ffffff';
            else
                textColor = '000000';
        }

        this._bgRed = parseInt(color.substring(0, 2), 16) / 255;
        this._bgGreen = parseInt(color.substring(2, 4), 16) / 255;
        this._bgBlue = parseInt(color.substring(4, 6), 16) / 255;

        if (Utils.relativeLuminance(color) > OUTLINE_LUMINANCE_THREASHHOLD)
            this._hasOutline = true;

        /* for compact (overview) mode, try to shorten the label if the route
         * name was more than 6 characters */
        if (this._compact && label.length > 6) {
            if (this._leg.route.startsWith(this._leg.agencyName)) {
                /* if the agency name is a prefix of the route name, display the
                 * agency name in the overview, this way we get a nice "transition"
                 * into the expanded route showing the full route name */
                label = this._leg.agencyName;
            } else if (this._leg.tripShortName &&
                       (this._leg.agencyName.length <
                        this._leg.tripShortName.length)) {
                /* if the agency name is shorter than the trip short name,
                 * which can sometimes be a more "internal" number, like a
                 * "train number", which is less known by the general public,
                 * prefer the agency name */
                label = this._leg.agencyName;
            } else if (this._leg.tripShortName &&
                       this._leg.tripShortName.length <= 6) {
                /* if the above conditions are unmet, use the trip short name
                 * as a fallback if it was shorter than the original route name */
                label = this._leg.tripShortName;
            }
            /* if none of the above is true, use the original route name,
             * and rely on label ellipsization */
        }

        /* restrict number of characters shown in the label when compact mode
         * is requested */
        if (this._compact)
            this.max_width_chars = 6;

        this.label =
            '<span foreground="#%s">%s</span>'.format(textColor, label);
    },

    /* I didn't find any easy/obvious way to override widget background color
     * and getting rounded corner just using CSS styles, so doing a custom
     * Cairo drawing of a "roundrect" */
    _onDraw: function(widget, cr) {
        let width = widget.get_allocated_width();
        let height = widget.get_allocated_height();
        let radius = 3;

        cr.newSubPath();
        cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
        cr.arc(width - radius, height - radius, radius, 0 , Math.PI / 2);
        cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
        cr.closePath();

        cr.setSourceRGB(this._bgRed, this._bgGreen, this._bgBlue);
        cr.fillPreserve();

        if (this._hasOutline) {
            cr.setSourceRGB(0, 0, 0);
            cr.setLineWidth(1);
            cr.stroke();
        }

        return false;
    }
});
