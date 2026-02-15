/**
 * Unit tests for Telegram location handler helpers
 *
 * Tests quick action generation based on geocoding results
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { getLocationQuickActions } from '../../src/channels/telegram/handlers/location';

describe('Location Handler Helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getLocationQuickActions', () => {
    it('should return 4 actions when geocoding is null', () => {
      const actions = getLocationQuickActions(null);
      expect(actions).toHaveLength(4);
    });

    it('should use "this location" for weather when geocoding is null', () => {
      const actions = getLocationQuickActions(null);
      const weatherAction = actions.find(a => a.label === 'Weather here');
      expect(weatherAction).toBeDefined();
      expect(weatherAction!.query).toBe('this location');
    });

    it('should return 4 actions when geocoding has city', () => {
      const geocoding = {
        displayName: 'Kuala Lumpur, Malaysia',
        address: {
          road: 'Jalan Bukit Bintang',
          city: 'Kuala Lumpur',
          state: 'Wilayah Persekutuan',
          country: 'Malaysia',
          postcode: '50200',
        },
      };
      const actions = getLocationQuickActions(geocoding);
      expect(actions).toHaveLength(4);
    });

    it('should use city name for weather query when geocoding has city', () => {
      const geocoding = {
        displayName: 'Tokyo, Japan',
        address: {
          city: 'Tokyo',
          country: 'Japan',
        },
      };
      const actions = getLocationQuickActions(geocoding);
      const weatherAction = actions.find(a => a.label === 'Weather here');
      expect(weatherAction).toBeDefined();
      expect(weatherAction!.query).toBe('Tokyo');
    });

    it('should use "this location" when geocoding has no city', () => {
      const geocoding = {
        displayName: 'Some Rural Area',
        address: {
          road: 'Country Road',
          state: 'State',
          country: 'Country',
        },
      };
      const actions = getLocationQuickActions(geocoding);
      const weatherAction = actions.find(a => a.label === 'Weather here');
      expect(weatherAction).toBeDefined();
      expect(weatherAction!.query).toBe('this location');
    });

    it('should use "this location" when geocoding has no address', () => {
      const geocoding = {
        displayName: 'Unknown Place',
      };
      const actions = getLocationQuickActions(geocoding);
      const weatherAction = actions.find(a => a.label === 'Weather here');
      expect(weatherAction).toBeDefined();
      expect(weatherAction!.query).toBe('this location');
    });

    it('should include "Nearby restaurants" action', () => {
      const actions = getLocationQuickActions(null);
      const restaurant = actions.find(a => a.label === 'Nearby restaurants');
      expect(restaurant).toBeDefined();
      expect(restaurant!.action).toBe('search_nearby');
      expect(restaurant!.query).toBe('restaurants');
    });

    it('should include "Nearby cafes" action', () => {
      const actions = getLocationQuickActions(null);
      const cafes = actions.find(a => a.label === 'Nearby cafes');
      expect(cafes).toBeDefined();
      expect(cafes!.action).toBe('search_nearby');
      expect(cafes!.query).toBe('cafes');
    });

    it('should include "Directions home" action', () => {
      const actions = getLocationQuickActions(null);
      const directions = actions.find(a => a.label === 'Directions home');
      expect(directions).toBeDefined();
      expect(directions!.action).toBe('directions');
      expect(directions!.query).toBe('home');
    });

    it('should include "Weather here" action', () => {
      const actions = getLocationQuickActions(null);
      const weather = actions.find(a => a.label === 'Weather here');
      expect(weather).toBeDefined();
      expect(weather!.action).toBe('weather');
    });

    it('should have all actions with required properties', () => {
      const actions = getLocationQuickActions(null);
      for (const action of actions) {
        expect(action).toHaveProperty('label');
        expect(action).toHaveProperty('action');
        expect(action).toHaveProperty('query');
        expect(typeof action.label).toBe('string');
        expect(typeof action.action).toBe('string');
        expect(typeof action.query).toBe('string');
      }
    });
  });
});
