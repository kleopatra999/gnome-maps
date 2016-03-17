/* -*- Mode: JS2; indent-tabs-mode: nil; js2-basic-offset: 4 -*- */
/* vim: set et ts=4 sw=4: */
/*
 * Copyright (c) 2011, 2012, 2013 Red Hat, Inc.
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
 * Author: Zeeshan Ali (Khattak) <zeeshanak@gnome.org>
 *         Mattias Bengtsson <mattias.jc.bengtsson@gmail.com>
 */

const C_ = imports.gettext.dgettext;
const Cairo = imports.cairo;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const InstructionRow = imports.instructionRow;
const PlaceStore  = imports.placeStore;
const RouteEntry = imports.routeEntry;
const RouteQuery = imports.routeQuery;
const StoredRoute = imports.storedRoute;
const TransitItineraryRow = imports.transitItineraryRow;
const TransitOptions = imports.transitOptions;
const TransitPlan = imports.transitPlan;
const Utils = imports.utils;

// in org.gnome.desktop.interface
const CLOCK_FORMAT_KEY = 'clock-format';

let _desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
let clockFormat = _desktopSettings.get_string(CLOCK_FORMAT_KEY);

const Sidebar = new Lang.Class({
    Name: 'Sidebar',
    Extends: Gtk.Revealer,
    Template: 'resource:///org/gnome/Maps/ui/sidebar.ui',
    InternalChildren: [ 'distanceInfo',
                        'entryList',
                        'instructionList',
                        'instructionWindow',
                        'instructionSpinner',
                        'instructionStack',
                        'modeBikeToggle',
                        'modeCarToggle',
                        'modePedestrianToggle',
                        'modeTransitToggle',
                        'timeInfo',
                        'linkButtonStack',
                        'transitWindow',
                        'transitRevealer',
                        'transitHeader',
                        'transitTimeOptionsComboBox',
                        'transitTimeEntry',
                        'transitDateButton',
                        'transitDateCalendar',
                        'transitParametersMenuButton',
                        'transitListStack',
                        'transitOverviewListBox',
                        'transitItineraryListBox',
                        'transitItineraryBackButton',
                        'transitItineraryTimeLabel',
                        'transitItineraryDurationLabel',
                        'busCheckButton',
                        'tramCheckButton',
                        'trainCheckButton',
                        'subwayCheckButton',
                        'ferryCheckButton' ],

    _init: function(mapView) {
        this.parent({ transition_type: Gtk.RevealerTransitionType.SLIDE_LEFT });

        this._mapView = mapView;

        this._query = Application.routeQuery;
        this._initInstructionList();
        this._initTransitOptions();
        this._initTransportationToggles(this._modePedestrianToggle,
                                        this._modeBikeToggle,
                                        this._modeCarToggle,
                                        this._modeTransitToggle);

        this._initQuerySignals();
        this._query.addPoint(0);
        this._query.addPoint(1);
        this._switchRoutingMode(RouteQuery.Transportation.CAR);
    },

    _initTransportationToggles: function(pedestrian, bike, car, transit) {
        let transport = RouteQuery.Transportation;

        let onToggle = function(mode, button) {
            Utils.debug('onToggle: ' + mode + ', query.mode: ' + this._query.transportation);

            let previousMode = this._query.transportation;

            /* if the transportation mode changes to/from transit
               change the routing engine */
            if (button.active &&
                ((mode !== transport.TRANSIT
                  && previousMode === transport.TRANSIT)
                 || (mode === transport.TRANSIT
                     && previousMode !== transport.TRANSIT))) {
                Utils.debug('switching routing mode');
                this._switchRoutingMode(mode);
            }

            if (button.active && previousMode !== mode)
                this._query.transportation = mode;
        };
        pedestrian.connect('toggled', onToggle.bind(this, transport.PEDESTRIAN));
        car.connect('toggled', onToggle.bind(this, transport.CAR));
        bike.connect('toggled', onToggle.bind(this, transport.BIKE));
        transit.connect('toggled', onToggle.bind(this, transport.TRANSIT))

        let setToggles = function() {
            switch(Application.routeQuery.transportation) {
            case transport.PEDESTRIAN:
                pedestrian.active = true;
                break;
            case transport.CAR:
                car.active = true;
                break;
            case transport.BIKE:
                bike.active = true;
                break;
            case transport.TRANSIT:
                transit.active = true;
                break;
            }
        };

        setToggles();
        this._query.connect('notify::transportation', setToggles);
    },

    _switchRoutingMode: function(mode) {
        let graphHopper = Application.routeService;
        let openTripPlanner = Application.openTripPlanner;

        if (mode === RouteQuery.Transportation.TRANSIT) {
            Utils.debug('switching to transit');
            graphHopper.disconnect();
            openTripPlanner.connect();
            this._linkButtonStack.visible_child_name = 'openTripPlanner';
            this._resetTransitOptions();
            this._transitRevealer.reveal_child = true;
            this._clearInstructions();
        } else {
            Utils.debug('switch from transit');
            openTripPlanner.disconnect();
            graphHopper.connect();
            this._linkButtonStack.visible_child_name = 'graphHopper';
            this._transitRevealer.reveal_child = false;
        }
    },

    _initQuerySignals: function() {
        this._query.connect('point-added', (function(obj, point, index) {
            this._createRouteEntry(index, point);
        }).bind(this));

        this._query.connect('point-removed', (function(obj, point, index) {
            let row = this._entryList.get_row_at_index(index);
            row.destroy();
        }).bind(this));
    },

    _cancelStore: function() {
        Mainloop.source_remove(this._storeRouteTimeoutId);
        this._storeRouteTimeoutId = 0;
    },

    _createRouteEntry: function(index, point) {
        let type;
        if (index === 0)
            type = RouteEntry.Type.FROM;
        else if (index === this._entryList.get_children().length)
            type = RouteEntry.Type.TO;
        else
            type = RouteEntry.Type.VIA;

        let routeEntry = new RouteEntry.RouteEntry({ type: type,
                                                     point: point,
                                                     mapView: this._mapView });
        this._entryList.insert(routeEntry, index);

        if (type === RouteEntry.Type.FROM) {
            routeEntry.button.connect('clicked', (function() {
                let lastIndex = this._entryList.get_children().length;
                this._query.addPoint(lastIndex - 1);
            }).bind(this));

            this.bind_property('child-revealed',
                               routeEntry.entry, 'has_focus',
                               GObject.BindingFlags.DEFAULT);
        } else if (type === RouteEntry.Type.VIA) {
            routeEntry.button.connect('clicked', (function() {
                let row = routeEntry.get_parent();
                this._query.removePoint(row.get_index());
            }).bind(this));
        }

        this._initRouteDragAndDrop(routeEntry);
    },

    _initInstructionList: function() {
        let route = Application.routeService.route;
        let transitPlan = Application.openTripPlanner.plan;

        route.connect('reset', (function() {
            this._clearInstructions();

            let length = this._entryList.get_children().length;
            for (let index = 1; index < (length - 1); index++) {
                this._query.removePoint(index);
            }
        }).bind(this));

        this._query.connect('notify', (function() {
            if (this._query.isValid())
                this._instructionStack.visible_child = this._instructionSpinner;
            else
                this._clearInstructions();

            if (this._storeRouteTimeoutId)
                this._cancelStore();

        }).bind(this));

        route.connect('update', (function() {
            this._clearInstructions();

            if (this._storeRouteTimeoutId)
                this._cancelStore();

            this._storeRouteTimeoutId = Mainloop.timeout_add(5000, (function() {
                let placeStore = Application.placeStore;
                let places = this._query.filledPoints.map(function(point) {
                    return point.place;
                });
                let storedRoute = new StoredRoute.StoredRoute({
                    transportation: this._query.transportation,
                    route: route,
                    places: places,
                    geoclue: Application.geoclue
                });

                if (!storedRoute.containsNull) {
                    placeStore.addPlace(storedRoute,
                                        PlaceStore.PlaceType.RECENT_ROUTE);
                }
                this._storeRouteTimeoutId = 0;
            }).bind(this));

            route.turnPoints.forEach((function(turnPoint) {
                let row = new InstructionRow.InstructionRow({ visible: true,
                                                              turnPoint: turnPoint });
                this._instructionList.add(row);
            }).bind(this));

            /* Translators: %s is a time expression with the format "%f h" or "%f min" */
            this._timeInfo.label = _("Estimated time: %s").format(Utils.prettyTime(route.time));
            this._distanceInfo.label = Utils.prettyDistance(route.distance);
        }).bind(this));

        this._instructionList.connect('row-selected',(function(listbox, row) {
            if (row)
                this._mapView.showTurnPoint(row.turnPoint);
        }).bind(this));

        transitPlan.connect('update', (function() {
            this._clearTransitOverview();
            this._showTransitOverview();
            this._populateTransitItineraryOverview();
        }).bind(this));

        /* use list separators for the transit itinerary overview list */
        this._transitOverviewListBox.set_header_func((function(row, prev) {
            if (prev)
                row.set_header(new Gtk.Separator());
        }).bind(this));

        this._transitOverviewListBox.connect('row-activated',
                                             this._onItineraryActivated.bind(this));
        this._transitItineraryBackButton.connect('clicked',
                                                 this._showTransitOverview.bind(this));

    },

    _clearTransitOverview: function() {
        let listBox = this._transitOverviewListBox;
        listBox.forall(listBox.remove.bind(listBox));

        this._instructionStack.visible_child = this._transitWindow;
        this._timeInfo.label = '';
        this._distanceInfo.label = '';
    },

    _showTransitOverview: function() {
        this._transitListStack.visible_child_name = 'overview';
        this._transitHeader.visible_child_name = 'options';
    },

    _showTransitItineraryView: function() {
        this._transitListStack.visible_child_name = 'itinerary';
        this._transitHeader.visible_child_name = 'itinerary-header';
    },

    _populateTransitItineraryOverview: function() {
        let plan = Application.openTripPlanner.plan;

        plan.itineraries.forEach((function(itinerary) {
            let row =
                new TransitItineraryRow.TransitItineraryRow({ visible: true,
                                                              itinerary: itinerary });
            this._transitOverviewListBox.add(row);
        }).bind(this));
    },

    _onItineraryActivated: function(listBox, row) {
        this._populateTransitItinerary(row.itinerary);
        this._showTransitItineraryView();
        this._transitOverviewListBox.unselect_all();
    },

    _populateTransitItinerary: function(itinerary) {
        this._transitItineraryTimeLabel.label =
            itinerary.prettyPrintTimeInterval();
        this._transitItineraryDurationLabel.label =
            itinerary.prettyPrintDuration();

        /* TODO: populate list of itinerary legs */
    },

    _initTransitOptions: function() {
        this._transitTimeOptionsComboBox.connect('changed',
            this._onTransitTimeOptionsComboboxChanged.bind(this));
        this._transitTimeEntry.connect('activate',
            this._onTransitTimeEntryActivated.bind(this));
        /* trigger an update of the query time as soon as focus leave the time
         * entry, to allow the user to enter a time before selecting start
         * and destination without having to press enter */
        this._transitTimeEntry.connect('focus-out-event',
            this._onTransitTimeEntryActivated.bind(this));
        this._transitDateButton.popover.get_child().connect('day-selected-double-click',
            this._onTransitDateCalenderDaySelected.bind(this));
        this._transitDateButton.connect('toggled',
            this._onTransitDateButtonToogled.bind(this));
        this._transitParametersMenuButton.connect('toggled',
            this._onTransitParametersToggled.bind(this))
    },

    _resetTransitOptions: function() {
        /* reset to indicate departure now and forget any previous manually
         * set time and date */
        this._transitTimeOptionsComboBox.active_id = 'leaveNow';
        this._timeSelected = false;
        this._dateSelected = false;
    },

    _onTransitTimeOptionsComboboxChanged: function() {
        if (this._transitTimeOptionsComboBox.active_id === 'leaveNow') {
            this._transitTimeEntry.visible = false;
            this._transitDateButton.visible = false;
            this._query.arriveBy = false;
            this._query.time = null;
            this._query.date = null;
        } else {
            this._transitTimeEntry.visible = true;
            this._transitDateButton.visible = true;

            if (!this._timeSelected)
                this._updateTransitTimeEntry(GLib.DateTime.new_now_local());

            if (!this._dateSelected)
                this._updateTransitDateButton(GLib.DateTime.new_now_local());

            if (this._transitTimeOptionsComboBox.active_id === 'arriveBy') {
                this._query.arriveBy = true;
            } else {
                this._query.arriveBy = false;
                /* TODO: if the user hasn't already manually entered a
                 * time, fill in the current time in the time entry */
            }
        }
    },

    _parseTimeString: function(timeString) {
        let pmSet = false;
        let hours;
        let mins;
        /* remove extra whitespaces */
        timeString = timeString.replace(/\s+/g, '');

        if (timeString.endsWith('am')) {
            timeString = timeString.substring(0, timeString.length - 2);
        } else if (timeString.endsWith('pm')) {
            timeString = timeString.substring(0, timeString.length - 2);
            pmSet = true;
        }

        if (timeString.charAt(2) === ':' || timeString.charAt(1) === ':')
            timeString = timeString.replace(':', '');
        else if (timeString.charAt(2) === '\u2236' ||
                 timeString.charAt(1) === '\u2236')
            timeString = timeString.replace('\u2236', '');

        if (timeString.length === 4) {
            /* expect a full time specification (hours, minutes) */
            hours = timeString.substring(0, 2);
            mins = timeString.substring(2, 4);
        } else if (timeString.length === 3) {
            /* interpret a 3 digit string as h:mm */
            hours = '0' + timeString.substring(0, 1);
            mins = timeString.substring(1, 3);
        } else if (timeString.length === 2) {
            /* expect just the hour part */
            hours = timeString.substring(0, 2);
            mins = '00';
        } else if (timeString.length === 1) {
            /* expect just the hour part, one digit */
            hours = '0' + timeString;
            mins = '00';
        } else {
            /* this makes no sense, just bail out */
            return null;
        }

        /* check if the parts can be interpreted as numbers */
        if (hours % 1 === 0 && mins % 1 === 0) {
            if (pmSet)
                hours = parseInt(hours) + 12;

            /* if the hours or minutes is out-of-range, bail out */
            if (hours < 0 || hours > 24 || mins < 0 || mins > 59)
                return null;

            return hours + ':' + mins;
        } else {
            return null;
        }
    },

    _updateTransitTimeEntry: function(time) {
        if (clockFormat === '24h')
            this._transitTimeEntry.text = time.format('%R');
        else
            this._transitTimeEntry.text = time.format('%r');
    },

    _onTransitTimeEntryActivated: function() {
        let timeString = this._transitTimeEntry.text;

        if (timeString && timeString.length > 0) {
            timeString = this._parseTimeString(timeString);

            Utils.debug('entered time parsed as: ' + timeString);

            if (timeString) {
                this._query.time = timeString;
                /* remember that the user has selected a time */
                this._timeSelected = true;
            }
        }
    },

    _updateTransitDateButton: function(date) {
        /*
         * Translators: this is a format string giving the equivalent to
         * "may 29" according to the current locale's convensions.
         */
        this._transitDateButton.label =
            date.format(C_("month-day-date", "%b %e"));
    },

    _onTransitDateCalenderDaySelected: function() {
        let calendar = this._transitDateButton.popover.get_child();
        let year = calendar.year;
        let month = calendar.month + 1;
        let day = calendar.day;
        let date = year + '-' + month + '-' + day;

        Utils.debug('day selected: ' + date);

        this._query.date = date;
        this._transitDateButton.active = false;
        this._updateTransitDateButton(GLib.DateTime.new_local(year, month, day,
                                                              0, 0, 0));
        /* remember that the user has already selected a date */
        this._dateSelected = true;
    },

    _onTransitDateButtonToogled: function() {
        if (!this._transitDateButton.active)
            this._onTransitDateCalenderDaySelected();
    },

    _createTransitOptions: function() {
        let options = new TransitOptions.TransitOptions();
        let busSelected = this._busCheckButton.active;
        let tramSelected = this._tramCheckButton.active;
        let trainSelected = this._trainCheckButton.active;
        let subwaySelected = this._subwayCheckButton.active;
        let ferrySelected = this._ferryCheckButton.active;

        if (busSelected && tramSelected && trainSelected && subwaySelected &&
            ferrySelected) {
            options.showAllRouteTypes = true;
        } else {
            if (busSelected)
                options.addRouteTypeToShow(TransitPlan.RouteType.BUS);
            if (tramSelected)
                options.addRouteTypeToShow(TransitPlan.RouteType.TRAM);
            if (trainSelected)
                options.addRouteTypeToShow(TransitPlan.RouteType.TRAIN);
            if (subwaySelected)
                options.addRouteTypeToShow(TransitPlan.RouteType.SUBWAY);
            if (ferrySelected)
                options.addRouteTypeToShow(TransitPlan.RouteType.FERRY);
        }

        return options;
    },

    _onTransitParametersToggled: function() {
        if (!this._transitParametersMenuButton.active) {
            let options = this._createTransitOptions();
            this._query.transitOptions = options;
        }
    },

    _clearInstructions: function() {
        let listBox = this._instructionList;
        listBox.forall(listBox.remove.bind(listBox));

        this._instructionStack.visible_child = this._instructionWindow;
        this._timeInfo.label = '';
        this._distanceInfo.label = '';
    },

    // Iterate over points and establish the new order of places
    _reorderRoutePoints: function(srcIndex, destIndex) {
        let points = this._query.points;
        let srcPlace = this._draggedPoint.place;

        // Determine if we are swapping from "above" or "below"
        let step = (srcIndex < destIndex) ? -1 : 1;

        // Hold off on notifying the changes to query.points until
        // we have re-arranged the places.
        this._query.freeze_notify();

        for (let i = destIndex; i !== (srcIndex + step); i += step) {
            // swap
            [points[i].place, srcPlace] = [srcPlace, points[i].place];
        }

        this._query.thaw_notify();
    },

    _onDragDrop: function(row, context, x, y, time) {
        let srcIndex = this._query.points.indexOf(this._draggedPoint);
        let destIndex = row.get_index();

        this._reorderRoutePoints(srcIndex, destIndex);
        Gtk.drag_finish(context, true, false, time);
        return true;
    },

    _dragHighlightRow: function(row) {
        row.opacity = 0.6;
    },

    _dragUnhighlightRow: function(row) {
        row.opacity = 1.0;
    },

    // Set the opacity of the row we are currently dragging above
    // to semi transparent.
    _onDragMotion: function(row, context, x, y, time) {
        let routeEntry = row.get_child();

        if (this._draggedPoint && this._draggedPoint !== routeEntry.point) {
            this._dragHighlightRow(row);
            Gdk.drag_status(context, Gdk.DragAction.MOVE, time);
        } else
            Gdk.drag_status(context, 0, time);
        return true;
    },

    // Drag ends, show the dragged row again.
    _onDragEnd: function(context, row) {
        this._draggedPoint = null;

        // Restore to natural height
        row.height_request = -1;
        row.get_child().show();
    },

    // Drag begins, set the correct drag icon and hide the dragged row.
    _onDragBegin: function(context, row) {
        let routeEntry = row.get_child();
        let dragEntry = this._dragWidget.get_child();

        this._draggedPoint = routeEntry.point;

        // Set a fixed height on the row to prevent the sidebar height
        // to shrink while dragging a row.
        let height = row.get_allocated_height();
        row.height_request = height;
        row.get_child().hide();

        dragEntry.entry.text = routeEntry.entry.text;
        Gtk.drag_set_icon_surface(context,
                                  this._dragWidget.get_surface(), 0, 0);
    },

    // We add RouteEntry to an OffscreenWindow and paint the background
    // of the entry to be transparent. We can later use the GtkOffscreenWindow
    // method get_surface to generate our drag icon.
    _initDragWidget: function() {
        let dragEntry = new RouteEntry.RouteEntry({ type: RouteEntry.Type.TO,
                                                    name: 'dragged-entry',
                                                    app_paintable: true });
        this._dragWidget = new Gtk.OffscreenWindow({ visible: true });

        dragEntry.connect('draw', (function(widget, cr) {
            cr.setSourceRGBA(0.0, 0.0, 0.0, 0.0);
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
        }).bind(this));

        this._dragWidget.add(dragEntry);
    },

    // Set up drag and drop between RouteEntrys. The drag source is from a
    // GtkEventBox that contains the start/end icon next in the entry. And
    // the drag destination is the ListBox row.
    _initRouteDragAndDrop: function(routeEntry) {
        let dragIcon = routeEntry.iconEventBox;
        let row = routeEntry.get_parent();

        dragIcon.drag_source_set(Gdk.ModifierType.BUTTON1_MASK,
                                 null,
                                 Gdk.DragAction.MOVE);
        dragIcon.drag_source_add_image_targets();

        row.drag_dest_set(Gtk.DestDefaults.MOTION,
                          null,
                          Gdk.DragAction.MOVE);
        row.drag_dest_add_image_targets();

        dragIcon.connect('drag-begin', (function(icon, context) {
            this._onDragBegin(context, row);
        }).bind(this));
        dragIcon.connect('drag-end', (function(icon, context) {
            this._onDragEnd(context, row);
        }).bind(this));

        row.connect('drag-leave', this._dragUnhighlightRow.bind(this, row));
        row.connect('drag-motion', this._onDragMotion.bind(this));
        row.connect('drag-drop', this._onDragDrop.bind(this));

        this._initDragWidget();
    }
});
